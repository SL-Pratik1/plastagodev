import type {
  Invoice,
  InvoiceDownload,
  InvoiceDownloads,
  InvoiceKind,
  InvoiceListItem,
  InvoiceStatus,
  PageMeta,
  RaisedInvoice,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { getStorage } from '../../integrations/storage.js';
import { logger } from '../../lib/logger.js';
import { centsToMoney, moneyToCents } from '../../lib/money.js';
import { withTransaction } from '../../lib/transaction.js';
import { buildInvoiceEmail } from '../../integrations/notice-messages.js';
import { accountRepository } from '../accounts/account.repository.js';
import { notificationService } from '../notifications/notification.service.js';
import { outboundService } from '../notifications/outbound.service.js';
import { billableCharges, jobRepository, setInvoiceStatus } from '../jobs/job.repository.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { invoiceRenderService } from './invoice-render.service.js';
import { xeroService } from '../xero/xero.service.js';
import {
  UNSENT_STATUSES,
  invoiceRepository,
  type CreateInvoiceInput,
  type InvoiceScope,
  type JobInvoiceRow,
  type ListInvoicesQuery,
} from './invoice.repository.js';

const log = logger.child({ module: 'invoices' });

/**
 * Invoicing (M7).
 *
 * ── The split is the whole point of this domain ───────────────────────────
 * Matt, 33:56, on why their current system loses them money:
 *
 *   *"the system we have doesn't really allow us to split onto two invoices"*
 *
 * Additional charges need their OWN purchase order, and that PO can take three
 * months to arrive. Today everything must go on one invoice, so the cash for a
 * pickup that has already happened waits on a PO for a $90 contamination
 * charge. Here the base invoice goes out immediately against the PO that was
 * already on the job, and the extras become a second invoice that waits on its
 * own without holding the first one up.
 *
 * ⚠️ Every figure is INTEGER CENTS internally and a decimal string on the wire
 * (§6A.10 #1). These have to match TransVirtual to the cent (Risk 1).
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

/** Roles that may send, approve and record POs. */
const FINANCE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

/**
 * An id that matches nothing, for a customer whose session carries no account.
 * Fail CLOSED — "which account is this" with no answer means none of them.
 */
const MATCHES_NOTHING = '000000000000000000000000';

/** GST is 10% in Australia and is not a setting anybody may change. */
const GST_DIVISOR = 10;

export const invoiceService = {
  async list(
    query: ListInvoicesQuery,
    caller: Caller,
  ): Promise<{ data: InvoiceListItem[]; meta: PageMeta }> {
    return invoiceRepository.list(query, scopeFor(caller));
  },

  async get(id: string, caller: Caller): Promise<Invoice> {
    const invoice = await invoiceRepository.findById(id, scopeFor(caller));

    // 404, not 403 — a 403 confirms the invoice exists, and an invoice carries
    // what somebody pays.
    if (!invoice) throw AppError.notFound('No such invoice');

    return invoice;
  },

  /**
   * M7.1 — bill a finished job: raise its invoices, or bring the unsent ones up
   * to date with its charges.
   *
   * ── Why this is one call that may produce two invoices ────────────────────
   * Because the split is a property of the ACCOUNT's PO policy, not a choice at
   * the point of invoicing. An account with no PO requirement gets everything on
   * one document: the split exists to unblock cash, and where nothing is blocked
   * it would only be noise on a builder's desk.
   *
   * ── Why it can change an invoice as well as create one ────────────────────
   * It used to create and nothing else, and refused once the job had an
   * invoice of each kind. So a charge approved AFTER the invoice was raised was
   * never billed at all: a $120 futile fee approved eleven minutes too late sat
   * on its job, on no invoice, with no way to add it. Now such a charge joins
   * the job's invoice while that is still unsent, or rides on a second invoice
   * once the first has gone out. See `billJob`.
   *
   * Idempotent. A retried completion, or two office staff clicking at once, must
   * not bill the customer twice — `job_kind_unique` enforces that in the
   * database, and a charge already on an invoice is never placed again, so the
   * second caller gets an explanation rather than a duplicate.
   */
  async generateForJob(jobId: string, caller: Caller): Promise<RaisedInvoice[]> {
    assertFinance(caller);

    const job = await jobRepository.findById(jobId, {
      accountId: null,
      bookedByUserId: null,
      driverId: null,
    });
    if (!job) throw AppError.notFound('No such job');

    /*
     * Only finished work is invoiced. A job still on a truck has no final
     * charges — the driver may yet report contamination — and invoicing it would
     * bill for a collection that has not happened.
     */
    if (!FINISHED_JOB_STATUSES.has(job.status)) {
      throw AppError.conflict(
        `Job ${String(job.jobNumber)} is ${job.status} — only completed or futile jobs can be invoiced`,
      );
    }

    const outcome = await billJob(job);
    if (outcome.invoices.length > 0) return outcome.invoices;

    /*
     * Nothing raised or changed is not success.
     *
     * This used to answer `201` with an empty array when every invoice already
     * existed, which reads to any caller as "done" — pressing it twice looked
     * like it worked twice and silently did nothing the second time. Say why
     * instead.
     */
    if (outcome.billable === 0) {
      throw AppError.conflict(
        job.status === 'futile'
          ? `Job ${String(job.jobNumber)} has nothing billable on it — the futile fee is still waiting for approval, or was waived`
          : `Job ${String(job.jobNumber)} has nothing billable on it — every charge is pending or rejected`,
      );
    }

    if (outcome.blocked.length > 0) throw AppError.conflict(outcome.blocked.join(' '));

    const raised = await invoiceRepository.forJob(jobId);
    throw AppError.conflict(
      `Job ${String(job.jobNumber)} has already been invoiced — nothing further to raise${
        raised.length > 0 ? ` (${raised.map((invoice) => invoice.kind).join(' and ')})` : ''
      }`,
    );
  },

  /**
   * M2.7 → M7.3 — bill the charges an approval has just made billable.
   *
   * ── Why approving bills ───────────────────────────────────────────────────
   * The approvals screen told the office an approved charge "moves to the
   * Awaiting PO queue". It did not: approving flipped a flag, the charge went on
   * no invoice, and it dropped out of every list anybody works from — money the
   * office believed was being chased, and was not.
   *
   * So a finished job is billed the moment one of its charges is approved: the
   * extras land on their own invoice (in Awaiting PO where the account needs a
   * PO), or join the job's unsent invoice. A job still under way is left alone
   * and billed with the job, and the caller is told so rather than promised a
   * queue entry that is not coming yet.
   *
   * ⚠️ Never throws. The approval is already committed by the time this runs,
   * and a billing failure must not turn a successful decision into an error the
   * office retries — that would be "none of those charges could be decided". A
   * failure is reported back per job, and Raise invoice on the job finishes it.
   */
  async billApprovedCharges(jobIds: readonly string[]): Promise<ApprovalBilling> {
    const result: ApprovalBilling = { invoices: [], awaitingJobCompletion: [], notInvoiced: [] };

    for (const jobId of jobIds) {
      const job = await jobRepository
        .findById(jobId, { accountId: null, bookedByUserId: null, driverId: null })
        .catch((error: unknown) => {
          log.error({ err: error, jobId }, 'could not read a job to bill its approved charges');
          return null;
        });
      if (!job) continue;

      if (!FINISHED_JOB_STATUSES.has(job.status)) {
        result.awaitingJobCompletion.push(job.jobNumber);
        continue;
      }

      try {
        const outcome = await billJob(job);

        result.invoices.push(
          ...outcome.invoices.map((invoice) => ({
            invoiceNumber: invoice.invoiceNumber,
            jobNumber: job.jobNumber,
            kind: invoice.kind,
            status: invoice.status,
            change: invoice.change,
          })),
        );

        if (outcome.blocked.length > 0) {
          result.notInvoiced.push({ jobNumber: job.jobNumber, reason: outcome.blocked.join(' ') });
        }
      } catch (error) {
        log.error(
          { err: error, jobId, jobNumber: job.jobNumber },
          'approved charges could not be billed — Raise invoice on the job will finish it',
        );
        result.notInvoiced.push({
          jobNumber: job.jobNumber,
          reason:
            error instanceof AppError
              ? error.message
              : 'Billing it failed — use Raise invoice on the job to try again.',
        });
      }
    }

    return result;
  },

  /**
   * M7.7 — draft → sent, in bulk.
   *
   * Returns how many actually changed rather than throwing on the ones that did
   * not: a bulk action on a grid selection is expected to be partly a no-op, and
   * failing the whole batch because one row moved would make the button useless.
   */
  async send(ids: readonly string[], caller: Caller): Promise<number> {
    assertFinance(caller);
    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    const now = new Date();

    /*
     * ⚠️ `awaiting-po` is deliberately NOT in `fromStatuses`. An invoice still
     * waiting on a purchase order must not go out — that is the entire point of
     * the queue, and a builder's AP system rejects an invoice with no PO on it
     * anyway (Matt, 9:56).
     */
    const changed = await invoiceRepository.transitionMany({
      ids,
      fromStatuses: ['draft', 'unknown'],
      to: 'sent',
      scope: scopeFor(caller),
      set: { sentAt: now },
    });

    if (changed === 0) {
      const existing = await invoiceRepository.existingIds(ids, scopeFor(caller));

      throw AppError.conflict(
        existing.length === 0
          ? 'None of those invoices could be found'
          : 'None of the selected invoices could be sent — they may already be sent, or still waiting on a purchase order',
      );
    }

    /*
     * M7.7 — "sent" now means sent.
     *
     * ⚠️ AFTER the status transition, and per invoice rather than per batch.
     * The transition is the durable act (and the thing Xero and the ageing
     * report read); the emails are best-effort on top of it. One unreachable
     * accounts address must not roll back a batch of forty invoices, so each
     * send stands or fails alone and is recorded either way.
     */
    await Promise.all(ids.map((id) => emailInvoice(id, now, caller)));

    /*
     * I1 · M7.8 — and into Xero.
     *
     * Same contract as the email above and for the same reason: after the
     * durable transition, per invoice, and never able to fail the batch. A
     * rejected invoice records "Xero push failed" on its own row with the
     * reason, which is where the office looks and what the Retry button acts
     * on. Rolling back forty sends because Xero disliked one account code
     * would be the wrong trade in both directions — the invoices really were
     * sent, and the customer already has the email.
     */
    await pushInvoicesToXero(ids, caller);

    log.info({ count: changed, by: caller.name }, 'invoices sent');
    return changed;
  },

  /**
   * M7.3 — release invoices whose PO has since been recorded.
   *
   * Only moves rows that ALREADY carry a PO. Approving without one would defeat
   * the account's PO policy, which is the thing standing between an invoice and
   * a builder's accounts department rejecting it.
   */
  async approve(ids: readonly string[], caller: Caller): Promise<number> {
    assertFinance(caller);
    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    const changed = await invoiceRepository.transitionMany({
      ids,
      fromStatuses: ['awaiting-po'],
      to: 'draft',
      scope: scopeFor(caller),
      requirePo: true,
    });

    if (changed === 0) {
      throw AppError.conflict(
        'These invoices still need a purchase order before they can be approved',
      );
    }

    log.info({ count: changed, by: caller.name }, 'invoices approved off the awaiting-PO queue');
    return changed;
  },

  /**
   * M7.3 — record the PO that unblocks an invoice.
   *
   * Recording it also RELEASES the invoice: the queue is "approved charges
   * awaiting a PO", so the PO arriving is the exit condition. Storing the number
   * without moving the status would leave the row sitting there with a PO
   * printed beside it, which is how a queue stops being trusted.
   */
  async recordPo(id: string, poNumber: string, caller: Caller): Promise<void> {
    assertFinance(caller);

    const trimmed = poNumber.trim();
    if (!trimmed) {
      throw AppError.validation('A purchase order number is required', [
        { path: 'poNumber', message: 'Enter the purchase order number the customer issued' },
      ]);
    }

    const result = await invoiceRepository.recordPo(id, trimmed, scopeFor(caller));
    if (!result.matched) throw AppError.notFound('No such invoice');

    /*
     * The job's rollup follows, so the jobs grid agrees with the invoice list —
     * worked out from ALL the job's invoices. It used to be set to `invoiced`
     * outright, which cleared the badge while a second invoice on the same job
     * was still waiting on its own PO.
     */
    if (result.jobId) await refreshJobRollup(result.jobId);

    log.info({ invoiceId: id, poNumber: trimmed, by: caller.name }, 'purchase order recorded');
  },

  /**
   * M7.6 — render the invoice PDFs and hand back links to them.
   *
   * ── Why this returns URLs and no longer just a count ──────────────────────
   * ⚠️ It used to render into storage and answer `{ queued }`, which meant the
   * document existed and nobody could open it: the office pressed "PDF", saw a
   * toast, and the only rendering of an invoice anyone ever laid eyes on was the
   * copy attached to the customer's email. An invoice that has been sent to a
   * builder but never seen by the business that sent it is the defect this
   * closes.
   *
   * `downloads` may be SHORTER than `requested`: a brand with no template fails
   * that invoice alone, and the screen has to be able to say so rather than
   * report a success it did not have.
   */
  async requestPdf(ids: readonly string[], caller: Caller): Promise<InvoiceDownloads> {
    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    // Through the caller's own scope, so a customer cannot render somebody
    // else's invoice by pasting an id.
    const existing = await invoiceRepository.existingIds(ids, scopeFor(caller));
    if (existing.length === 0) throw AppError.notFound('None of those invoices could be found');

    /*
     * ⚠️ Rendered here rather than handed to a queue.
     *
     * `pdf-lib` draws in-process with no browser, so one invoice is a few
     * milliseconds — the connection-holding problem that justified a queue was
     * a property of spawning Chromium, and it went away with Chromium. A bulk
     * request is still bounded below so a fifty-invoice render cannot become a
     * request that never returns.
     */
    const context = await invoiceRenderService.context();
    const downloads: InvoiceDownload[] = [];

    for (const id of existing) {
      const invoice = await invoiceRepository.findById(id, scopeFor(caller));
      if (!invoice) continue;

      const download = await downloadFor(invoice, context);
      if (download) downloads.push(download);
    }

    log.info(
      { count: downloads.length, of: existing.length, by: caller.name },
      'invoice PDFs rendered',
    );
    return { requested: existing.length, downloads };
  },

  /**
   * I1 · M7.8 — re-push one invoice to Xero after a failure.
   *
   * ── Why this pushes inline rather than queueing ───────────────────────
   * It is a single invoice, triggered by somebody looking at the row and
   * waiting for an answer. Queueing it would mean the button reports success
   * whatever happens next and the user reloads until the badge changes —
   * which is exactly the "did that work?" experience this screen exists to
   * replace. The bulk path is different and does not come through here.
   *
   * Safe to press repeatedly: the push upserts on the stored `xeroInvoiceId`,
   * so a retry updates the invoice in Xero rather than raising a second one.
   */
  async retryXero(id: string, caller: Caller): Promise<{ pushed: boolean; message: string | null }> {
    assertFinance(caller);

    // Through the caller's own scope, so a retry cannot be aimed at an
    // invoice this person is not allowed to see.
    const invoice = await invoiceRepository.findById(id, scopeFor(caller));
    if (!invoice) throw AppError.notFound('No such invoice');

    if (invoice.status === 'draft' || invoice.status === 'awaiting-po') {
      throw AppError.conflict(
        'That invoice has not been sent yet, so there is nothing to push to Xero',
      );
    }

    const result = await xeroService.pushInvoice(id);

    log.info(
      { invoiceId: id, by: caller.name, pushed: result.pushed },
      'xero push retried',
    );

    return result;
  },
};

/* ── Billing a job (M7.1, M7.3) ──────────────────────────────────────────── */

/** A job is billable once the work is over: collected, closed by the office, or futile. */
const FINISHED_JOB_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'admin-complete',
  'futile',
]);

/** The one charge a futile job is billed for. See `billJob`. */
const FUTILE_FEE_CODE = 'futile-pickup';

/** Both kinds, base first — the order a job's invoices are numbered in. */
const INVOICE_KIND_ORDER: readonly InvoiceKind[] = ['base', 'additional-charges'];

type BillableJob = NonNullable<Awaited<ReturnType<typeof jobRepository.findById>>>;
type BillableAccount = NonNullable<Awaited<ReturnType<typeof accountRepository.findById>>>;
type BillableCharge = Awaited<ReturnType<typeof billableCharges>>[number];

/** What billing an approval did, per job. See `billApprovedCharges`. */
export interface ApprovalBilling {
  invoices: Array<{
    invoiceNumber: number;
    jobNumber: number;
    kind: InvoiceKind;
    status: InvoiceStatus;
    change: 'created' | 'updated';
  }>;
  /** Jobs still under way — their charges are billed with the job. */
  awaitingJobCompletion: number[];
  notInvoiced: Array<{ jobNumber: number; reason: string }>;
}

interface BillingOutcome {
  /** Invoices created or changed, in numbering order. */
  invoices: RaisedInvoice[];
  /** Billable charges that could not be placed on any invoice, in words. */
  blocked: string[];
  /** How many charges on the job are billable at all. */
  billable: number;
}

/**
 * Brings a finished job's invoices into line with its billable charges.
 *
 *  • A charge on an invoice that has GONE OUT is settled and never placed again.
 *  • Every other billable charge goes on the invoice of its kind — the base
 *    invoice, or the additional-charges one that waits for its own PO — and an
 *    unsent invoice is rewritten to carry exactly its charges.
 *  • Once the base invoice has gone out, a new charge rides on the
 *    additional-charges invoice instead of being refused.
 *  • An unsent invoice left with nothing billable on it is removed.
 *
 * Running it twice changes nothing the second time, which is what makes it safe
 * to call from both the Raise invoice button and every approval.
 */
async function billJob(job: BillableJob): Promise<BillingOutcome> {
  const account = await accountRepository.findById(job.accountId, { accountId: null });
  if (!account) throw AppError.notFound('The account behind this job no longer exists');

  const [settings, existing, charges] = await Promise.all([
    settingsRepository.get(),
    invoiceRepository.forJob(job.id),
    billableCharges(job.id),
  ]);

  /*
   * ⚠️ A futile job bills the attendance fee and NOTHING else.
   *
   * Its service fee, area and bag charges were written at booking for a
   * pickup that never happened, and they used to go on the invoice beside the
   * fee — $930 billed for a truck turned away at the gate, with the rebooked
   * job then billing the full price again. A waived fee leaves nothing to bill.
   */
  const billable =
    job.status === 'futile' ? charges.filter((charge) => charge.code === FUTILE_FEE_CODE) : charges;

  const requiresPo = account.poPolicy === 'required-before-invoice';
  const split = requiresPo && settings.invoicing.splitAdditionalCharges;

  const current = new Map(existing.map((invoice) => [invoice.kind, invoice]));
  const hasGoneOut = (kind: InvoiceKind): boolean => {
    const invoice = current.get(kind);
    return invoice !== undefined && !UNSENT_STATUSES.includes(invoice.status);
  };

  const settled = new Set(
    existing
      .filter((invoice) => !UNSENT_STATUSES.includes(invoice.status))
      .flatMap((invoice) =>
        invoice.lines.flatMap((line) => (line.sourceChargeId ? [line.sourceChargeId] : [])),
      ),
  );

  const planned: Record<InvoiceKind, BillableCharge[]> = { base: [], 'additional-charges': [] };
  const blocked: string[] = [];

  for (const charge of billable) {
    if (settled.has(charge.id)) continue;

    /*
     * `system` and `office` charges are the job as sold: the service fee, the
     * area, the bags, anything the office added. `driver` charges are the
     * exceptions raised on site, and those are what need a second PO.
     */
    const preferred: InvoiceKind =
      split && charge.source === 'driver' ? 'additional-charges' : 'base';
    // The base invoice is already with the customer: a later charge goes on a second one.
    const kind: InvoiceKind =
      preferred === 'base' && hasGoneOut('base') ? 'additional-charges' : preferred;

    if (hasGoneOut(kind)) {
      blocked.push(
        `${charge.description} could not be billed — job ${String(job.jobNumber)}'s additional-charges invoice has already been sent.`,
      );
      continue;
    }

    planned[kind].push(charge);
  }

  const issuedOn = today();
  const termsDays = account.paymentTermsDays || settings.invoicing.defaultPaymentTermsDays;
  const invoices: RaisedInvoice[] = [];
  let changed = false;

  for (const kind of INVOICE_KIND_ORDER) {
    const lines = planned[kind];
    const invoice = current.get(kind);

    // Gone out: never touched. Anything meant for it was routed away above.
    if (invoice && !UNSENT_STATUSES.includes(invoice.status)) continue;

    if (!invoice) {
      if (lines.length === 0) continue;

      /*
       * The status decides whether this can go out.
       *
       *  • No PO policy → `draft`, ready to send.
       *  • PO required and we have one → `draft`.
       *  • PO required and we do not → `awaiting-po`, which is the M7.3 queue.
       *    That is where money currently leaks, so it is a STATE rather than an
       *    absence somebody has to notice.
       *
       * ⚠️ On a PO-required account the additional-charges invoice starts with
       * NO PO even though the base invoice had one. That is the split: it needs
       * a NEW purchase order, and until one arrives it waits in Awaiting PO.
       */
      const poNumber = kind === 'base' || !requiresPo ? job.poNumber : null;
      const status: InvoiceStatus = !requiresPo || poNumber ? 'draft' : 'awaiting-po';

      const created = await createInvoice({
        job,
        account,
        kind,
        status,
        poNumber,
        lines,
        issuedOn,
        termsDays,
      });
      invoices.push({ ...created, change: 'created' });
      changed = true;
      continue;
    }

    if (sameLines(invoice.lines, lines)) continue;

    if (lines.length === 0) {
      /*
       * An invoice that never went out, now carrying nothing billable — the
       * full price raised on a futile job before the rule above existed. A
       * draft for money nobody owes is worse than no draft.
       */
      if (await invoiceRepository.deleteUnsent(invoice.id)) {
        log.warn(
          { jobId: job.id, jobNumber: job.jobNumber, invoiceNumber: invoice.invoiceNumber },
          'removed an unsent invoice that had nothing billable left on it',
        );
        changed = true;
      }
      continue;
    }

    const updated = await invoiceRepository.replaceLines(invoice.id, {
      ...totalsFor(lines),
      lines: lines.map(toInvoiceLine),
    });

    if (updated) {
      invoices.push({ ...updated, change: 'updated' });
      changed = true;
    } else {
      // Sent in the moment between the read and the write. Its charges stay put.
      blocked.push(
        `Invoice ${String(invoice.invoiceNumber)} was sent while job ${String(job.jobNumber)} was being billed — try again to bill what is left.`,
      );
    }
  }

  if (changed) {
    await refreshJobRollup(job.id, job.invoiceNumber);

    log.info(
      {
        jobId: job.id,
        jobNumber: job.jobNumber,
        invoices: invoices.map((invoice) => ({
          number: invoice.invoiceNumber,
          kind: invoice.kind,
          status: invoice.status,
          change: invoice.change,
        })),
      },
      'job billed',
    );
  }

  return { invoices, blocked, billable: billable.length };
}

/** Writes one new invoice, removing it again if the degraded path fails part-way. */
async function createInvoice(input: {
  job: BillableJob;
  account: BillableAccount;
  kind: InvoiceKind;
  status: InvoiceStatus;
  poNumber: string | null;
  lines: readonly BillableCharge[];
  issuedOn: string;
  termsDays: number;
}): Promise<InvoiceListItem> {
  const invoiceNumber = await settingsRepository.takeNextNumber('nextInvoiceNumber');
  let createdId: string | null = null;

  return withTransaction(
    async () =>
      invoiceRepository
        .create({
          invoiceNumber,
          kind: input.kind,
          status: input.status,
          accountId: input.account.id,
          accountName: input.account.name,
          brandId: input.account.brandId,
          jobId: input.job.id,
          jobNumber: input.job.jobNumber,
          poNumber: input.poNumber,
          issuedOn: input.issuedOn,
          dueOn: addDays(input.issuedOn, input.termsDays),
          paymentTermsDays: input.termsDays,
          ...totalsFor(input.lines),
          templateName: 'Standard',
          notes: '',
          lines: input.lines.map(toInvoiceLine),
        })
        .then((row) => {
          createdId = row.id;
          return row;
        }),
    {
      label: 'create-invoice',
      compensate: async () => {
        if (createdId === null) return;
        log.warn({ invoiceNumber, invoiceId: createdId }, 'removing a half-created invoice');
        await invoiceRepository.deleteCascade(createdId);
      },
    },
  );
}

/**
 * The money on a set of lines.
 *
 * Rounded once, at the end. Rounding each line then summing produces a total
 * that disagrees with its own breakdown by a cent or two.
 */
function totalsFor(lines: readonly BillableCharge[]): {
  subtotalExGst: string;
  gst: string;
  totalIncGst: string;
} {
  const subtotalCents = lines.reduce((total, line) => total + moneyToCents(line.amount), 0);
  const gstCents = Math.round(subtotalCents / GST_DIVISOR);

  return {
    subtotalExGst: centsToMoney(subtotalCents),
    gst: centsToMoney(gstCents),
    totalIncGst: centsToMoney(subtotalCents + gstCents),
  };
}

function toInvoiceLine(charge: BillableCharge): CreateInvoiceInput['lines'][number] {
  return {
    description: charge.description,
    quantity: charge.quantity,
    unitRate: charge.unitRate,
    amount: charge.amount,
    raisedBy: charge.raisedBy,
    sourceChargeId: charge.id,
  };
}

/**
 * Whether an invoice already carries exactly these charges, as they now read.
 *
 * Compared on the figures as well as the ids, so a charge the office corrected
 * after the draft was raised brings the draft with it.
 */
function sameLines(existing: JobInvoiceRow['lines'], planned: readonly BillableCharge[]): boolean {
  if (existing.length !== planned.length) return false;

  const byCharge = new Map(existing.map((line) => [line.sourceChargeId, line]));
  return planned.every((charge) => {
    const line = byCharge.get(charge.id);
    return (
      line !== undefined &&
      line.description === charge.description &&
      line.quantity === charge.quantity &&
      line.unitRate === charge.unitRate &&
      line.amount === charge.amount
    );
  });
}

/**
 * The job's invoice badge, worked out from ALL its invoices.
 *
 * `awaiting-po` wins while any of them waits on a PO — the grid shows the
 * worst state, not the most optimistic. The number shown is the base
 * invoice's; `knownNumber` is what the job already records, so an unchanged
 * number is left alone rather than re-stamped with today's date.
 */
async function refreshJobRollup(jobId: string, knownNumber?: number | null): Promise<void> {
  const invoices = await invoiceRepository.forJob(jobId);

  const headline = invoices.find((invoice) => invoice.kind === 'base') ?? invoices[0];
  if (!headline) {
    await setInvoiceStatus(jobId, 'not-invoiced', null);
    return;
  }

  const status = invoices.some((invoice) => invoice.status === 'awaiting-po')
    ? 'awaiting-po'
    : invoices.every((invoice) => invoice.status === 'paid')
      ? 'paid'
      : 'invoiced';

  await setInvoiceStatus(
    jobId,
    status,
    knownNumber === undefined || headline.invoiceNumber === knownNumber
      ? undefined
      : headline.invoiceNumber,
  );
}

/* ── Xero (I1 · M7.8) ────────────────────────────────────────────────────── */

/**
 * Pushes a batch of just-sent invoices, one at a time.
 *
 * ── Why sequential and not `Promise.all` ──────────────────────────────────
 * The emails above fan out because SMTP does not care. Xero does: it enforces
 * a per-minute call ceiling per organisation, and each invoice here costs at
 * least two calls — a contact lookup and the upsert. Forty invoices fired at
 * once would trip the limiter, and the invoices that lost the race would each
 * record a rate-limit failure that looks to the office like a rejection.
 *
 * Sequential is also what makes the token refresh cheap: the first push
 * refreshes if it must and the remaining thirty-nine reuse the result.
 */
async function pushInvoicesToXero(ids: readonly string[], caller: Caller): Promise<void> {
  for (const id of ids) {
    try {
      await xeroService.pushInvoice(id);
    } catch (error) {
      /*
       * `pushInvoice` records its own outcomes and is not expected to throw.
       * This catch is for the case it does anyway — a bug, or Mongo going away
       * mid-batch — and it must not stop the remaining invoices, which have
       * already been sent to the customer either way.
       */
      log.error({ err: error, invoiceId: id, by: caller.name }, 'xero push threw');
    }
  }
}

/* ── Fetching the rendered document (M7.6) ──────────────────────────────── */

/**
 * One invoice's PDF, as a link the browser can follow.
 *
 * ── Why an existing PDF is reused rather than re-rendered ─────────────────
 * ⚠️ The stored bytes ARE the invoice. Re-rendering on every download would
 * quietly reprint the document against whatever the branding, the template and
 * the rate card say TODAY — so an invoice reprinted a year later would not match
 * the one in the builder's filing system, and the difference would surface in a
 * payment dispute rather than here. A PDF is drawn once and served forever.
 *
 * Returns `null` rather than throwing: this is called per invoice inside a
 * batch, and one brand with no template configured must not deny the other
 * forty-nine their documents.
 */
async function downloadFor(
  invoice: Invoice,
  context: Awaited<ReturnType<typeof invoiceRenderService.context>>,
): Promise<InvoiceDownload | null> {
  try {
    const key = invoice.pdfKey ?? (await invoiceRenderService.render(invoice, context));

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      /*
       * Named for a filing system, not for a URL — this is what somebody sees
       * in their downloads folder and searches for a year later. Deliberately
       * the same name the emailed attachment carries, so the copy the office
       * downloads and the copy the customer received are one document with one
       * name rather than two files that have to be reconciled.
       */
      fileName: `Invoice ${context.invoiceNumberPrefix}${String(invoice.invoiceNumber)}.pdf`,
      url: await getStorage().presignDownload(key),
    };
  } catch (error) {
    log.error({ err: error, invoiceId: invoice.id }, 'invoice pdf unavailable for download');
    return null;
  }
}

/* ── The covering email (M7.7 · M8.4) ───────────────────────────────────── */

/**
 * Emails one invoice to the people who pay it.
 *
 * ── Why it re-reads the invoice instead of trusting the selection ──────────
 * `transitionMany` reports HOW MANY rows moved, not which — a bulk action over
 * a grid selection is expected to be partly a no-op. Emailing everything that
 * was selected would therefore send a covering note for invoices that were
 * already sent last week. Matching `sentAt` to this batch's timestamp is what
 * identifies the ones that actually moved just now.
 */
async function emailInvoice(id: string, sentAt: Date, caller: Caller): Promise<void> {
  const invoice = await invoiceRepository.findById(id, scopeFor(caller));

  // Not ours to send: already sent, still awaiting a PO, or out of scope.
  if (!invoice || invoice.status !== 'sent' || invoice.sentAt !== sentAt.toISOString()) return;

  const account = await accountRepository.findById(invoice.accountId, { accountId: null });

  /*
   * Accounts payable, not the site.
   *
   * M8.4 exists for exactly this: *"today there is exactly one email — the site
   * contact. The AP person who needs the invoice..."*. A foreman forwarding
   * invoices to his own accounts department is the delay this removes. The
   * fallback to any emailable contact is deliberate — an invoice reaching the
   * wrong desk inside the right company still gets paid; one that goes nowhere
   * does not.
   */
  const contacts = account?.contacts ?? [];
  const payable = contacts.filter(
    (contact) => contact.role === 'accounts' && contact.email && contact.notifyByEmail,
  );
  const recipients = payable.length > 0 ? payable : contacts.filter((contact) => contact.email);

  const context = {
    accountName: invoice.accountName,
    invoiceNumber: invoice.invoiceNumber,
    totalIncGst: invoice.totalIncGst,
    dueOn: invoice.dueOn,
    paymentTermsDays: invoice.paymentTermsDays,
    jobNumber: invoice.jobNumber,
    poNumber: invoice.poNumber,
  };

  /*
   * M7.6 — the PDF the customer actually files.
   *
   * ⚠️ Fetched ONCE and attached to every recipient's copy. Two people at the
   * same builder get the identical document, and rendering per contact would
   * produce two objects in storage for one invoice.
   *
   * `null` where it could not be produced. That is not a reason to withhold
   * the email: the invoice has been sent, the customer needs to know, and a
   * covering note with no attachment is recoverable in a way silence is not.
   */
  const renderContext = await invoiceRenderService.context();
  const pdf = await invoiceRenderService.bytesForSending(invoice, renderContext);

  const attachments =
    pdf === null
      ? undefined
      : [
          {
            // Named for a filing system, not for a URL: this is what the
            // recipient sees in their inbox and searches for a year later.
            filename: `Invoice ${renderContext.invoiceNumberPrefix}${String(invoice.invoiceNumber)}.pdf`,
            contentType: 'application/pdf',
            content: pdf,
          },
        ];

  if (pdf === null) {
    log.warn(
      { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber },
      'invoice emailed without its PDF — render unavailable',
    );
  }

  for (const contact of recipients) {
    await outboundService.send({
      event: 'invoice-sent',
      // Per contact: two people at the same builder each need their own copy,
      // and each is its own row in the log.
      subjectKey: `invoice-sent:${invoice.id}:${contact.id}`,
      recipient: {
        email: contact.email,
        mobile: null,
        notifyByEmail: contact.notifyByEmail,
      },
      email: (to) => ({ ...buildInvoiceEmail(to, context), ...(attachments ? { attachments } : {}) }),
      accountId: invoice.accountId,
      invoiceId: invoice.id,
      jobId: invoice.jobId,
    });
  }

  /*
   * And in the portal, where somebody looking at their account sees it without
   * having found the email. `action` rather than `info`: an invoice is
   * something to do, and one waiting on a PO is something to do urgently.
   *
   * ⚠️ Administrators only. This went to every portal user on the account, so
   * each site supervisor got the invoice total in their inbox — the one figure
   * M1.5 says they must never see, on a screen (Invoices) they cannot open.
   */
  await notificationService.notifyAccountAdministrators({
    accountId: invoice.accountId,
    category: 'invoice',
    severity: 'action',
    title: `Invoice INV-${String(invoice.invoiceNumber)} — ${invoice.totalIncGst}`,
    body: invoice.dueOn
      ? `Due ${invoice.dueOn}.${invoice.poNumber ? ` Purchase order ${invoice.poNumber}.` : ''}`
      : `Payment terms ${String(invoice.paymentTermsDays)} days.`,
    href: '/portal/invoices',
    subjectKey: `invoice-sent:${invoice.id}`,
    valueExGst: invoice.subtotalExGst,
    jobId: invoice.jobId,
    jobNumber: invoice.jobNumber,
  });
}

/* ── Scoping ─────────────────────────────────────────────────────────────── */

function isCustomer(caller: Caller): boolean {
  return caller.roles.some((role) => CUSTOMER_ROLES.has(role));
}

function scopeFor(caller: Caller): InvoiceScope {
  if (!isCustomer(caller)) return { accountId: null };
  return { accountId: caller.accountId ?? MATCHES_NOTHING };
}

/**
 * Who may change an invoice.
 *
 * A customer READS their own invoices — that is the portal. They do not send,
 * approve or record POs against them, because those are the acts that decide
 * what PlastaGo bills and when.
 */
function assertFinance(caller: Caller): void {
  if (!caller.roles.some((role) => FINANCE_ROLES.has(role))) {
    throw AppError.forbidden('Only the office can change an invoice');
  }
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/**
 * Payment terms in CALENDAR days, not business days.
 *
 * Deliberately different from the job SLA (M2.4a), which is in business days
 * because trucks do not run at weekends. An invoice due date is a banking term
 * the customer agreed to — "7 days" means seven days.
 */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
