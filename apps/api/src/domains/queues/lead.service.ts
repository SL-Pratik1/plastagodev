import type {
  InvitationResult,
  Lead,
  LeadAttachment,
  LeadConversion,
  LeadCreate,
  LeadListItem,
  LeadPipelineStats,
  LeadUpdate,
  PageMeta,
  Role,
} from '@plastago/shared';
import { LEAD_ATTACHABLE_TYPES } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import {
  MAX_UPLOAD_BYTES,
  buildKey,
  getStorage,
  type PresignedUpload,
} from '../../integrations/storage.js';
import { buildLeadAckEmail, buildWelcomeEmail } from '../../integrations/notice-messages.js';
import { accountRepository } from '../accounts/account.repository.js';
import { notificationService } from '../notifications/notification.service.js';
import { outboundService } from '../notifications/outbound.service.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { leadRepository, type ListLeadsQuery } from './lead.repository.js';

const log = logger.child({ module: 'leads' });

/**
 * Leads and onboarding (M5, Journey A).
 *
 * ── What this domain is for ───────────────────────────────────────────────
 * Before it existed, a builder who rang 1300 395 438 either lived in somebody's
 * notebook or was typed straight in as a JOB — the "leads arrive disguised as
 * jobs" problem. A job implies an account, a rate card and terms; an enquiry
 * implies none of those.
 *
 * A lead becomes an account only through A.4, which is where the customer code,
 * the rate card and the terms are decided — deliberately, and by a human.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** Who works the pipeline. */
const SALES_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

/** A.4 creates an ACCOUNT, which is a commercial decision. Narrower. */
const CONVERTER_ROLES = new Set<Role>(['super-admin', 'operations']);

/**
 * Proposals are PDFs. An allow-list, for the same reason as driver photos.
 *
 * The list itself lives in `@plastago/shared` because the console's file
 * pickers advertise it — see `LEAD_ATTACHABLE_TYPES`.
 */
const ATTACHABLE_TYPES = new Set<string>(LEAD_ATTACHABLE_TYPES);

export const leadService = {
  async list(
    query: ListLeadsQuery,
    caller: Caller,
  ): Promise<{ data: LeadListItem[]; meta: PageMeta }> {
    assertSales(caller);
    return leadRepository.list(query);
  },

  /**
   * The three cards above the grid.
   *
   * ⚠️ Its own call rather than a field on the list response, because the list
   * is PAGED and FILTERED and these three numbers are neither. Hanging them off
   * the list response would make them change when somebody typed in the search
   * box — a conversion rate that moves when you filter is a number nobody can
   * quote.
   */
  async stats(caller: Caller): Promise<LeadPipelineStats> {
    assertSales(caller);
    return leadRepository.pipelineStats();
  },

  async get(id: string, caller: Caller): Promise<Lead> {
    assertSales(caller);

    const lead = await leadRepository.findById(id);
    if (!lead) throw AppError.notFound('No such lead');

    // Attachment URLs are minted per read and expire — a proposal link that
    // lived forever would outlive the reason anybody had for seeing it.
    return { ...lead, attachments: await withUrls(lead.attachments, id) };
  },

  /**
   * A.1 — take a lead by hand, for the enquiries that never touch the web form.
   *
   * ── Why so little is required ─────────────────────────────────────────────
   * A web form can insist. A phone call cannot: the caller is on the line, and a
   * required "expected frequency" is a reason to abandon the record and lose the
   * lead entirely. So what is required is only what makes the lead CHASEABLE —
   * who they are and how to reach them. A thin lead in the queue beats a perfect
   * one in a notebook.
   */
  async create(input: LeadCreate, caller: Caller): Promise<Lead> {
    assertSales(caller);

    /*
     * A duplicate is flagged, not blocked. The same builder can legitimately
     * enquire twice — a year apart, or for a different division — so refusing
     * would lose a real lead to protect against a tidy database.
     */
    const existing = await leadRepository.findByEmail(input.email);
    if (existing.length > 0) {
      log.info(
        { email: input.email, existing: existing.length },
        'creating a lead for an address that already has one open',
      );
    }

    const id = await leadRepository.create({
      companyName: input.companyName,
      contactName: input.contactName,
      email: input.email,
      mobile: input.mobile.trim() || null,
      source: input.source,
      zone: input.zone,
      suburbs: input.suburbs,
      typicalVolumeM2: input.typicalVolumeM2,
      expectedFrequency: input.expectedFrequency,
      heardAbout: input.heardAbout,
      ownerName: input.ownerName.trim() || caller.name,
    });

    // The call itself becomes the first entry in the thread — otherwise what
    // was actually said is lost the moment the person hangs up.
    if (input.note.trim()) {
      await leadRepository.addNote({
        leadId: id,
        body: input.note.trim(),
        author: caller.name,
        authorId: caller.userId,
      });
    }

    const lead = await leadRepository.findById(id);
    if (!lead) throw new Error('Lead vanished immediately after being created');

    /*
     * A.4 — the enquiry form is answered by the product, not by whoever gets to
     * the queue first.
     *
     * ⚠️ Only for `enquiry-form`. A lead the office typed up during a phone
     * call has already been acknowledged by the person on the phone; emailing
     * them afterwards to say somebody will be in touch reads as if nobody
     * noticed they had rung. See `notice-messages.ts`.
     */
    if (input.source === 'enquiry-form') {
      await outboundService.send({
        event: 'lead-acknowledged',
        subjectKey: `lead-ack:${id}`,
        recipient: { email: input.email, mobile: null },
        email: (to) =>
          buildLeadAckEmail(to, {
            contactName: input.contactName,
            companyName: input.companyName,
          }),
      });

      /*
       * And the office is told, because nobody watches a queue. An enquiry that
       * sits for three days is the failure this notification exists to prevent
       * — the same argument as the sweep in `notification.service.ts`.
       */
      await notificationService.notifyOffice({
        category: 'queue',
        severity: 'action',
        title: `New website enquiry — ${input.companyName}`,
        body: `${input.contactName} asked about ${String(input.typicalVolumeM2)} m² in ${input.zone}. They have been sent an acknowledgement; somebody owes them a call.`,
        href: `/queues/leads/${id}`,
        subjectKey: `lead-new:${id}`,
      });
    }

    log.info({ leadId: id, company: input.companyName, source: input.source }, 'lead created');
    return lead;
  },

  /** Moves a lead along the pipeline, with a note saying why. */
  async update(id: string, input: LeadUpdate, caller: Caller): Promise<LeadListItem> {
    assertSales(caller);

    const changed = await leadRepository.update(id, {
      status: input.status,
      ownerName: input.ownerName.trim() || null,
    });

    if (!changed) {
      // Either it does not exist, or it has been converted — and a converted
      // lead is history. Both read as "you cannot work this one".
      throw AppError.notFound('No such open lead');
    }

    if (input.note.trim()) {
      await leadRepository.addNote({
        leadId: id,
        body: input.note.trim(),
        author: caller.name,
        authorId: caller.userId,
      });
    }

    const lead = await leadRepository.findById(id);
    if (!lead) throw AppError.notFound('No such lead');

    log.info({ leadId: id, status: input.status, by: caller.name }, 'lead updated');
    return lead;
  },

  /**
   * Attach a proposal (Matt, 5:53).
   *
   * Returns a presigned upload URL — the bytes go straight to object storage,
   * the same path as driver photos. The API never holds the file.
   */
  async attach(
    leadId: string,
    input: { fileName: string; contentType: string; sizeBytes: number },
    caller: Caller,
  ): Promise<{ attachmentId: string; upload: PresignedUpload }> {
    assertSales(caller);

    const lead = await leadRepository.findById(leadId);
    if (!lead) throw AppError.notFound('No such lead');

    if (!ATTACHABLE_TYPES.has(input.contentType)) {
      throw AppError.validation('That file type cannot be attached', [
        { path: 'contentType', message: 'Attach a PDF, a Word document or an image' },
      ]);
    }

    if (input.sizeBytes > MAX_UPLOAD_BYTES) {
      throw AppError.validation('That file is too large', [
        {
          path: 'sizeBytes',
          message: `Attachments must be under ${String(Math.round(MAX_UPLOAD_BYTES / 1024 / 1024))} MB`,
        },
      ]);
    }

    const key = buildKey({
      scope: 'leads',
      ownerId: leadId,
      kind: 'attachments',
      contentType: input.contentType,
    });

    const [upload, created] = await Promise.all([
      getStorage().presignUpload({
        key,
        contentType: input.contentType,
        contentLength: input.sizeBytes,
      }),
      leadRepository.addAttachment({
        leadId,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        contentType: input.contentType,
        uploadedBy: caller.name,
        storageKey: key,
      }),
    ]);

    return { attachmentId: created.id, upload };
  },

  /**
   * Remove an attachment.
   *
   * A hard delete, deliberately: a wrong file on a lead is noise, and a
   * soft-deleted proposal that still shows in a list is worse than none.
   */
  async detach(leadId: string, attachmentId: string, caller: Caller): Promise<void> {
    assertSales(caller);

    const attachment = await leadRepository.findAttachment(attachmentId, leadId);
    if (!attachment) throw AppError.notFound('No such attachment on this lead');

    await leadRepository.removeAttachment(attachmentId, leadId);
    await getStorage().remove(attachment.storageKey);

    log.info({ leadId, attachmentId, by: caller.name }, 'lead attachment removed');
  },

  /**
   * A.4 — Convert Lead → Account.
   *
   * ── Why nothing here is defaulted ─────────────────────────────────────────
   * Every field is one the account cannot exist without: M2.8 lists the customer
   * code, ABN, brand, rate card, PO policy, capture mode and payment terms. A
   * silently defaulted rate card is a pricing incident that shows up a month
   * later as an invoice nobody can explain.
   *
   * ⚠️ No first site is created. It was optional (Matt, 6:31) and is now absent
   * entirely — there is no Site record to create (0:29). An account is a
   * commercial relationship; where the truck goes is typed on the first booking.
   */
  async convert(
    id: string,
    input: LeadConversion,
    caller: Caller,
  ): Promise<{ accountId: string; customerCode: string; welcome: InvitationResult | null }> {
    assertConverter(caller);

    const lead = await leadRepository.findById(id);
    if (!lead) throw AppError.notFound('No such lead');

    if (lead.convertedAccountId !== null) {
      throw AppError.conflict(
        `${lead.companyName} has already been converted — open the account instead`,
      );
    }

    if (await accountRepository.codeExists(input.customerCode)) {
      /*
       * The suggestion is the point.
       *
       * The dialog proposes "first three letters + 001", so every builder whose
       * name starts the same way collides on the same code — and the old
       * message ("choose a code that is not already taken") asked the office to
       * guess against a list only the server can see.
       */
      const suggestion = await accountRepository.nextFreeCode(input.customerCode);

      throw AppError.validation(`Customer code ${input.customerCode} is already in use`, [
        {
          path: 'customerCode',
          message: suggestion
            ? `${suggestion} is free — use that, or type another code.`
            : 'Choose a code that is not already taken',
        },
      ]);
    }

    /*
     * Same reason as the accounts domain: rate cards are runtime data now, so an
     * id that names nothing has to be refused HERE. Converting a lead onto a
     * card that no longer exists would create an account that cannot price its
     * first booking.
     */
    if (!(await settingsRepository.findRateCard(input.rateCardId))) {
      throw AppError.validation('That rate card does not exist', [
        { path: 'rateCardId', message: 'Pick a card from the list — it may have been retired' },
      ]);
    }

    const account = await accountRepository.create({
      code: input.customerCode,
      name: input.legalName,
      /*
       * Asked on the form, never defaulted. It decides whether the customer
       * gets site supervisors and which booking form they see (Matt, 21:55),
       * and nothing changes it afterwards without the office doing it
       * deliberately — so a silent `builder` here was a wrong journey that
       * surfaced as a support call weeks later.
       */
      accountType: input.accountType,
      brandId: input.brandId,
      rateCardId: input.rateCardId,
      poPolicy: input.poPolicy,
      captureMode: input.captureMode,
      abn: input.abn,
      paymentTermsDays: input.paymentTermsDays,
      primaryZone: input.primaryZone,
      notes: `Converted from lead — ${lead.companyName}`,
      // The lead's own contact carries across — otherwise the first thing the
      // office does with a brand-new account is retype what it already had.
      contact: { name: lead.contactName, email: lead.email },
      // Terms are accepted by the customer in the portal (M5.2), not asserted
      // here. A conversion that pre-signed them would be PlastaGo agreeing on
      // the builder's behalf.
      termsAgreedOffSystem: null,
    });

    /*
     * The lead is marked converted SECOND, and its filter allows it only once.
     * If two people finish the wizard together the loser gets a conflict here,
     * after the account exists — which is recoverable and visible. The reverse
     * order would leave a lead marked converted with no account behind it.
     */
    const marked = await leadRepository.markConverted(id, account.id);

    if (!marked) {
      log.error(
        { leadId: id, accountId: account.id },
        'account created but the lead was already converted — two accounts may now exist',
      );
      throw AppError.conflict(
        'That lead was converted by somebody else while you were working — check for a duplicate account',
      );
    }

    await leadRepository.addNote({
      leadId: id,
      body: `Converted to account ${input.customerCode} (${input.legalName}).`,
      author: caller.name,
      authorId: caller.userId,
    });

    log.info(
      { leadId: id, accountId: account.id, code: input.customerCode, by: caller.name },
      'lead converted to account',
    );

    /*
     * A.4 finishes by welcoming them in.
     *
     * ⚠️ LAST, and unable to throw. This is the worst possible place to lose an
     * account that already exists — the code is taken, the lead is marked
     * converted, and neither can be undone by a mail server being down. So the
     * send is best-effort and its outcome is returned instead of thrown, and
     * the office is told which of the two happened.
     */
    let welcome: InvitationResult | null = null;

    if (input.sendInvitation) {
      welcome = await outboundService.send({
        event: 'account-welcome',
        subjectKey: `account-welcome:${account.id}`,
        recipient: { email: lead.email, mobile: null },
        email: (to) =>
          buildWelcomeEmail(to, {
            contactName: lead.contactName,
            legalName: input.legalName,
            customerCode: input.customerCode,
          }),
        accountId: account.id,
      });

      log.info({ accountId: account.id, outcome: welcome.outcome }, 'welcome email attempted');
    }

    return { accountId: account.id, customerCode: input.customerCode, welcome };
  },

  /** The nav badge. */
  async countOpen(): Promise<number> {
    return leadRepository.countOpen();
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Mints a short-lived URL per attachment. The storage key never leaves here. */
async function withUrls(attachments: LeadAttachment[], leadId: string): Promise<LeadAttachment[]> {
  if (attachments.length === 0) return attachments;

  const storage = getStorage();
  const keys = await leadRepository.attachmentKeys(leadId);

  return Promise.all(
    attachments.map(async (attachment) => {
      const key = keys.get(attachment.id);
      if (!key) return attachment;

      /*
       * ⚠️ Checked, not assumed. `attach` writes the row when it hands out the
       * upload URL — BEFORE the browser has PUT anything — so a row can exist
       * for an object that was never written: a dialog abandoned mid-upload, a
       * dropped connection, a signature the client got wrong.
       *
       * Handing out a URL for one of those renders a link that 404s when
       * clicked, which reads as a broken feature rather than an unfinished
       * upload. `url: null` is exactly what the shared schema already means by
       * "still in flight", and the screen renders it as plain text.
       */
      if (!(await storage.exists(key))) return attachment;

      return { ...attachment, url: await storage.presignDownload(key) };
    }),
  );
}

function assertSales(caller: Caller): void {
  if (!caller.roles.some((role) => SALES_ROLES.has(role))) {
    throw AppError.forbidden('The lead pipeline is for office staff');
  }
}

function assertConverter(caller: Caller): void {
  if (!caller.roles.some((role) => CONVERTER_ROLES.has(role))) {
    // Converting sets the rate card and the terms — that is a commercial
    // decision, not an administrative one.
    throw AppError.forbidden('Only operations can convert a lead into an account');
  }
}
