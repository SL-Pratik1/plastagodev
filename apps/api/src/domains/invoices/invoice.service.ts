import type {
  Invoice,
  InvoiceKind,
  InvoiceListItem,
  InvoiceStatus,
  PageMeta,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
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
  invoiceRepository,
  type InvoiceScope,
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
   * M7.1 — raise the invoices for a completed job.
   *
   * ── Why this is one call that may produce two invoices ────────────────────
   * Because the split is a property of the ACCOUNT's PO policy, not a choice at
   * the point of invoicing. An account with no PO requirement gets everything on
   * one document: the split exists to unblock cash, and where nothing is blocked
   * it would only be noise on a builder's desk.
   *
   * Idempotent. A retried completion, or two office staff clicking at once, must
   * not bill the customer twice — `job_kind_unique` enforces that in the
   * database, and this checks first so the second caller gets an explanation
   * rather than a duplicate-key error.
   */
  async generateForJob(jobId: string, caller: Caller): Promise<InvoiceListItem[]> {
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
    if (job.status !== 'completed' && job.status !== 'admin-complete' && job.status !== 'futile') {
      throw AppError.conflict(
        `Job ${String(job.jobNumber)} is ${job.status} — only completed or futile jobs can be invoiced`,
      );
    }

    const account = await accountRepository.findById(job.accountId, { accountId: null });
    if (!account) throw AppError.notFound('The account behind this job no longer exists');

    const existing = await invoiceRepository.kindsForJob(jobId);
    const charges = await billableCharges(jobId);

    if (charges.length === 0) {
      throw AppError.conflict(
        `Job ${String(job.jobNumber)} has nothing billable on it — every charge is pending or rejected`,
      );
    }

    const settings = await settingsRepository.get();
    const requiresPo = account.poPolicy === 'required-before-invoice';

    /*
     * `system` and `office` charges are the job as sold: the service fee, the
     * area, the bags, anything the office added. `driver` charges are the
     * exceptions raised on site, and those are what need a second PO.
     */
    const baseCharges = charges.filter((charge) => charge.source !== 'driver');
    const extraCharges = charges.filter((charge) => charge.source === 'driver');

    // Where nothing is blocked, one invoice. See the note above.
    const split = requiresPo && settings.invoicing.splitAdditionalCharges;

    const issuedOn = today();
    const termsDays = account.paymentTermsDays || settings.invoicing.defaultPaymentTermsDays;
    const created: InvoiceListItem[] = [];

    const plan: Array<{ kind: InvoiceKind; lines: typeof charges; poNumber: string | null }> = split
      ? [
          { kind: 'base', lines: baseCharges, poNumber: job.poNumber },
          /*
           * ⚠️ `poNumber: null` even though the base invoice has one. That is
           * the split: this invoice needs a NEW purchase order, and until it
           * arrives the row sits in the awaiting-PO queue (M7.3).
           */
          { kind: 'additional-charges', lines: extraCharges, poNumber: null },
        ]
      : [{ kind: 'base', lines: charges, poNumber: job.poNumber }];

    for (const entry of plan) {
      if (entry.lines.length === 0) continue;
      if (existing.includes(entry.kind)) {
        log.info(
          { jobId, jobNumber: job.jobNumber, kind: entry.kind },
          'invoice already exists for this job and kind — skipping',
        );
        continue;
      }

      const subtotalCents = entry.lines.reduce(
        (total, line) => total + moneyToCents(line.amount),
        0,
      );
      // Rounded once, at the end. Rounding each line then summing produces a
      // total that disagrees with its own breakdown by a cent or two.
      const gstCents = Math.round(subtotalCents / GST_DIVISOR);

      /*
       * The status decides whether this can go out.
       *
       *  • No PO policy → `draft`, ready to send.
       *  • PO required and we have one → `draft`.
       *  • PO required and we do not → `awaiting-po`, which is the M7.3 queue.
       *    That is where money currently leaks, so it is a STATE rather than an
       *    absence somebody has to notice.
       */
      const status: InvoiceStatus = !requiresPo || entry.poNumber ? 'draft' : 'awaiting-po';

      const invoiceNumber = await settingsRepository.takeNextNumber('nextInvoiceNumber');
      let createdId: string | null = null;

      const invoice = await withTransaction(
        async () =>
          invoiceRepository
            .create({
              invoiceNumber,
              kind: entry.kind,
              status,
              accountId: account.id,
              accountName: account.name,
              brandId: account.brandId,
              jobId,
              jobNumber: job.jobNumber,
              poNumber: entry.poNumber,
              issuedOn,
              dueOn: addDays(issuedOn, termsDays),
              paymentTermsDays: termsDays,
              subtotalExGst: centsToMoney(subtotalCents),
              gst: centsToMoney(gstCents),
              totalIncGst: centsToMoney(subtotalCents + gstCents),
              templateName: 'Standard',
              notes: '',
              lines: entry.lines.map((line) => ({
                description: line.description,
                quantity: line.quantity,
                unitRate: line.unitRate,
                amount: line.amount,
                raisedBy: line.raisedBy,
                sourceChargeId: line.id,
              })),
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

      created.push(invoice);
    }

    /*
     * Nothing raised is not success.
     *
     * Every entry in the plan was skipped — the job already carries an invoice
     * of each kind its charges would produce — and this used to answer `201`
     * with an empty array, which reads to any caller as "done". Pressing it
     * twice therefore looked like it worked twice and silently did nothing the
     * second time. Say which invoices are already there instead.
     */
    if (created.length === 0) {
      const raised = await invoiceRepository.kindsForJob(jobId);
      throw AppError.conflict(
        `Job ${String(job.jobNumber)} has already been invoiced — nothing further to raise${
          raised.length > 0 ? ` (${raised.join(' and ')})` : ''
        }`,
      );
    }

    if (created.length > 0) {
      /*
       * The job's rollup badge follows, so the jobs grid agrees with the invoice
       * list. `awaiting-po` wins when anything raised is still blocked — the
       * grid should show the worst state, not the most optimistic one.
       */
      const blocked = created.some((invoice) => invoice.status === 'awaiting-po');
      const base = created.find((invoice) => invoice.kind === 'base');

      await setInvoiceStatus(
        jobId,
        blocked ? 'awaiting-po' : 'invoiced',
        base?.invoiceNumber,
      );

      log.info(
        {
          jobId,
          jobNumber: job.jobNumber,
          raised: created.map((invoice) => ({
            number: invoice.invoiceNumber,
            kind: invoice.kind,
            status: invoice.status,
          })),
        },
        'invoices raised for job',
      );
    }

    return created;
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

    // The job's rollup follows, so the jobs grid agrees with the invoice list.
    if (result.jobId) await setInvoiceStatus(result.jobId, 'invoiced');

    log.info({ invoiceId: id, poNumber: trimmed, by: caller.name }, 'purchase order recorded');
  },

  /**
   * M7.6 — render the invoice PDFs.
   *
   * Returns how many were PRODUCED, not how many were asked for: a template
   * missing for one brand fails that invoice alone, and the screen needs to
   * say so rather than report a success it did not have.
   */
  async requestPdf(ids: readonly string[], caller: Caller): Promise<{ queued: number }> {
    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    // Through the caller's own scope, so a customer cannot render somebody
    // else's invoice by pasting an id.
    const existing = await invoiceRepository.existingIds(ids, scopeFor(caller));
    if (existing.length === 0) throw AppError.notFound('None of those invoices could be found');

    /*
     * ⚠️ Rendered here rather than handed to a queue, and the doc comment above
     * no longer claims otherwise.
     *
     * `pdf-lib` draws in-process with no browser, so one invoice is a few
     * milliseconds — the connection-holding problem that justified a queue was
     * a property of spawning Chromium, and it went away with Chromium. A bulk
     * request is still bounded below so a fifty-invoice render cannot become a
     * request that never returns.
     */
    const context = await invoiceRenderService.context();
    let rendered = 0;

    for (const id of existing) {
      const invoice = await invoiceRepository.findById(id, scopeFor(caller));
      if (!invoice) continue;

      try {
        await invoiceRenderService.render(invoice, context);
        rendered += 1;
      } catch (error) {
        /*
         * Per invoice, never fatal to the batch. One invoice whose template is
         * missing must not deny the other forty-nine their PDFs, and the
         * office can see which one failed.
         */
        log.error({ err: error, invoiceId: id }, 'invoice pdf render failed');
      }
    }

    log.info({ count: rendered, of: existing.length, by: caller.name }, 'invoice PDFs rendered');
    return { queued: rendered };
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
   */
  await notificationService.notifyAccount({
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
