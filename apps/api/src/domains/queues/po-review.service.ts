import type {
  PageMeta,
  PoConfirmation,
  PoExtraction,
  PoExtractionItem,
  Role,
} from '@plastago/shared';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { extractorClient, TERMINAL_FAILURES } from '../../integrations/extractor.js';
import { getStorage } from '../../integrations/storage.js';
import { accountRepository } from '../accounts/account.repository.js';
import { supervisorProvisioning } from '../portal/supervisor-provisioning.service.js';
import { adaptCallUp } from './call-up-ingest.adapter.js';
import { callUpService } from './call-up.service.js';
import { adaptExtraction } from './po-ingest.adapter.js';
import { purchaseOrderRepository } from './purchase-order.repository.js';
import {
  poExtractionRepository,
  type IngestExtractionInput,
  type ListExtractionsQuery,
} from './po-extraction.repository.js';

const log = logger.child({ module: 'po-review' });

/**
 * M2.12 — AI purchase-order review.
 *
 * ── The one rule this service exists to enforce ───────────────────────────
 * Risk 9: **never silently guess.** An extraction is a PROPOSAL. It becomes a
 * purchase order because a human confirmed it, never because a model scored
 * highly.
 *
 * ⚠️ A wrong PO number landing silently on an invoice is worse than no
 * extraction at all: the builder's accounts system rejects the invoice weeks
 * later and nobody knows why. The confirmation step is the whole product.
 *
 * ── What this service does NOT do ─────────────────────────────────────────
 * It does not read email and it does not run a model. An external extractor
 * posts fields to `ingest`; this owns the queue, the confirmation and the audit
 * trail — the parts that must not be re-implemented per vendor. Swapping the
 * extractor is a change to whatever calls `ingest`, and nothing here.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** Confirming a PO decides what can be invoiced. Office only. */
const REVIEWER_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

export const poReviewService = {
  async list(
    query: ListExtractionsQuery,
    caller: Caller,
  ): Promise<{ data: PoExtractionItem[]; meta: PageMeta }> {
    assertReviewer(caller);
    return poExtractionRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<PoExtraction> {
    assertReviewer(caller);

    const extraction = await poExtractionRepository.findById(id);
    if (!extraction) throw AppError.notFound('No such extraction');

    /*
     * The reviewer reads figures off the ORIGINAL, not off the extraction. That
     * is the point of review: comparing what was pulled out against what the
     * page actually says.
     */
    const stored = await poExtractionRepository.findStorageKey(id);

    return {
      ...extraction,
      documentUrl: await presignIfPresent(stored),
    };
  },

  /**
   * Where an external extractor posts what it read.
   *
   * ── Why everything arriving here is treated as a claim ────────────────────
   * The caller is a model. It may be confident and wrong, it may match the
   * wrong account, and it may read a PO number off a page footer. So nothing it
   * sends takes effect: the row lands in `needs-review` regardless of
   * confidence, and the reason it needs review is recorded as a first-class
   * field so the human knows what to check.
   */
  async ingest(input: IngestExtractionInput, caller: Caller): Promise<{ id: string }> {
    /*
     * ⚠️ Who may put something into this queue, which is not the same question
     * as who is signed in.
     *
     * The route's own note says an unauthenticated ingest "is a way for anybody
     * to put a plausible-looking purchase order in front of the office", and
     * that a service extractor "does not get an exemption" — but nothing here
     * read the caller, so every signed-in account had the exemption in practice.
     * A driver or, worse, a CUSTOMER could post a purchase order naming any
     * number and amount into the queue whose whole purpose is to stop a machine
     * billing somebody. Confirming one writes a real order against an account.
     *
     * The webhook path is unaffected: it authenticates with its own shared
     * secret and goes through `ingestFromExtractor`, which writes to the
     * repository directly.
     */
    assertReviewer(caller);

    /*
     * The review reason is decided HERE, not by the extractor — it says what a
     * reviewer should look at first, and a vendor does not get a say in that.
     *
     * It no longer decides WHETHER anybody looks. Nothing ever auto-accepted,
     * but a score sitting on the screen invited waving through the high ones;
     * the reason is now a hint about where to start, and the document itself is
     * the check.
     */
    const reason = await resolveReason(input);

    const id = await poExtractionRepository.ingest({ ...input, reason });

    log.info(
      {
        extractionId: id,
        from: input.fromAddress,
        poNumber: input.poNumber,
        reason,
      },
      'purchase-order extraction received for review',
    );

    return { id };
  },

  /**
   * I6 — the extractor has finished reading a document.
   *
   * ── Why the callback's body is thrown away ────────────────────────────────
   * The vendor's webhook carries the extracted data inline, and using it would
   * mean an unauthenticated HTTP request decides what appears in front of the
   * office. So the callback is treated as a PING: it names an id, and this
   * fetches that id from the vendor with our own credentials.
   *
   * A forged callback can then achieve exactly one thing — making us re-read a
   * document that genuinely exists in our own tenant.
   *
   * ── Why an unfinished or failed extraction is not an error ────────────────
   * The vendor fires on state changes, and only `completed` carries data. A
   * `processing` ping is normal traffic, and answering it with a 4xx would put
   * the vendor's retry loop to work on a document that is simply not ready.
   */
  async ingestFromExtractor(extractionId: string): Promise<{ id: string } | null> {
    if (!extractorClient.enabled) {
      // Configuration, not a caller error: the route exists but the pipeline is
      // switched off, and a 503 says that honestly.
      throw AppError.dependencyUnavailable('The document extractor is not configured');
    }

    const alreadyQueued = await poExtractionRepository.findByExternalId(extractionId);
    if (alreadyQueued) {
      /*
       * Idempotent. The vendor retries on a non-2xx and can fire twice for one
       * document; a second row would put the same purchase order in front of two
       * reviewers, and the unique index on `(accountId, poNumber)` would then
       * fail whichever of them confirmed second.
       */
      log.info(
        { extractionId, existing: alreadyQueued },
        'extractor callback for a document already in the queue — ignored',
      );
      return { id: alreadyQueued };
    }

    const extraction = await extractorClient.getExtraction(extractionId);

    if (extraction.status !== 'completed') {
      if (TERMINAL_FAILURES.has(extraction.status)) {
        // Worth a warning: the document arrived and could not be read, so a
        // purchase order exists that nobody will see unless somebody looks.
        log.warn(
          { extractionId, status: extraction.status, detail: extraction.error },
          'the extractor could not read a purchase order',
        );
      }
      return null;
    }

    /*
     * ── The second document type in the same mailbox (M2.12b) ─────────────
     *
     * Matt, 23:37: *"all purchase orders and call-ups will go to the same email
     * address."* One inbox, two kinds of document, one webhook — so the template
     * the extractor matched is the only thing that separates "here is a job" from
     * "that job is ready on the 21st".
     *
     * ⚠️ Checked BEFORE the purchase-order filter below. Without this branch a
     * call-up would either be ignored (where the PO template id is set) or read
     * against the PO template and arrive in the review queue as an order with no
     * area, no allowance and no supervisor — a phantom purchase order.
     */
    if (
      env.EXTRACTOR_CALL_UP_DOCUMENT_ID &&
      extraction.documentId === env.EXTRACTOR_CALL_UP_DOCUMENT_ID
    ) {
      const adapted = adaptCallUp(extraction, {
        receivedAt: extraction.createdAt ? new Date(extraction.createdAt) : new Date(),
      });

      // No PO number at all: nothing to match now or by hand later.
      if (!adapted) return null;

      const outcome = await callUpService.record(adapted.input);
      return { id: outcome.id };
    }

    /*
     * A tenant may hold templates for other document types. Without this a
     * remittance advice read against an invoice template would arrive in the
     * purchase-order queue as a purchase order with no number.
     */
    if (env.EXTRACTOR_DOCUMENT_ID && extraction.documentId !== env.EXTRACTOR_DOCUMENT_ID) {
      log.info(
        { extractionId, documentId: extraction.documentId },
        'extractor callback for another document type — ignored',
      );
      return null;
    }

    const { input, diagnostics } = await adaptExtraction(extraction, {
      receivedAt: extraction.createdAt ? new Date(extraction.createdAt) : new Date(),
      subject: extraction.fileName,
    });

    const reason = await resolveReason({ ...input, reason: 'awaiting-check' });

    const id = await poExtractionRepository.ingest({
      ...input,
      reason,
      externalId: extraction.id,
    });

    log.info(
      {
        extractionId: id,
        externalId: extraction.id,
        poNumber: input.poNumber,
        reason,
        ...diagnostics,
      },
      'purchase order ingested from the extractor',
    );

    return { id };
  },

  /**
   * A human confirms the extraction into a real purchase order.
   *
   * ── Why the corrected values come back, not just the ids ──────────────────
   * M2.12: *"log confidence and correction rate from day one, so accuracy is a
   * measured number."* A confirm that only sent ids would throw away the signal
   * that says which fields the extractor keeps getting wrong — and without that
   * the decision to raise or lower an auto-accept threshold has nothing behind
   * it. Which fields the human changed is recorded on the extraction.
   */
  async confirm(id: string, input: PoConfirmation, caller: Caller): Promise<void> {
    assertReviewer(caller);

    const extraction = await poExtractionRepository.findById(id);
    if (!extraction) throw AppError.notFound('No such extraction');

    if (extraction.state !== 'needs-review') {
      throw AppError.conflict(
        `That extraction was already ${extraction.state} by ${extraction.reviewedBy ?? 'somebody else'}`,
      );
    }

    const account = await accountRepository.findById(input.accountId, { accountId: null });
    if (!account) {
      throw AppError.validation('That account could not be found', [
        { path: 'accountId', message: 'Choose an account from the list' },
      ]);
    }

    /*
     * ⚠️ `duplicate-po` is a review reason precisely because the same number
     * arriving twice means either a resend or a mistake. Checked again at
     * confirmation because the first extraction may have been confirmed in the
     * meantime — the database's unique index would otherwise fail this with an
     * error nobody can act on.
     */
    if (await poExtractionRepository.isDuplicate(input.accountId, input.poNumber)) {
      throw AppError.conflict(
        `${account.name} already has purchase order ${input.poNumber} on file`,
      );
    }

    const corrected = whatChanged(extraction, input);

    const result = await poExtractionRepository.confirm({
      extractionId: id,
      correctedFields: corrected,
      reviewedByUserId: caller.userId,
      reviewedBy: caller.name,
      order: {
        poNumber: input.poNumber,
        accountId: input.accountId,
        accountName: account.name,
        receivedAt: new Date(extraction.receivedAt),
        lotNumber: input.lotNumber,
        addressLine: input.addressLine,
        suburb: input.suburb,
        postcode: null,
        expectedAreaM2: input.expectedAreaM2,
        bagAllowance: input.bagAllowance,
        siteSupervisorName: input.siteSupervisorName,
        siteSupervisorMobile: input.siteSupervisorMobile,
        amountExGst: input.amountExGst,
        storageKey: await poExtractionRepository.findStorageKey(id),
        extractionId: id,
        createdByName: caller.name,
      },
    });

    if (!result) {
      // The claim did not match, which means somebody else reviewed it between
      // the read above and the write.
      throw AppError.conflict('That extraction was reviewed by somebody else — reload the queue');
    }

    /*
     * ⚠️ After the order is written, and never in front of it.
     *
     * Matt, 33:25, wants the supervisor on the order to get a login without
     * anybody keying one in. But confirming the purchase order is the act that
     * matters commercially, and it must not fail because ClickSend is down or
     * because that mobile turns out to belong to somebody else. So this runs
     * last, reports its outcome as a status rather than throwing, and a purchase
     * order with no supervisor attached stays perfectly usable — 34:52: *"it
     * just sits there with no site supervisor assigned and we can handle that
     * manually."*
     */
    const provisioned = await supervisorProvisioning.ensureForAccount({
      accountId: input.accountId,
      accountType: account.accountType,
      name: input.siteSupervisorName,
      mobile: input.siteSupervisorMobile,
      provisionedBy: caller.name,
      sourceLabel: `PO ${input.poNumber}`,
    });

    /*
     * Linked only where the login is genuinely this account's. A login that
     * belongs elsewhere is deliberately NOT attached: scoping a job to it would
     * show one builder's work to another builder's contact.
     */
    if (provisioned.status === 'created' || provisioned.status === 'reused') {
      await purchaseOrderRepository.setSupervisorUser(
        result.purchaseOrderId,
        provisioned.userId,
      );
    }

    log.info(
      {
        extractionId: id,
        purchaseOrderId: result.purchaseOrderId,
        poNumber: input.poNumber,
        accountId: input.accountId,
        supervisor: provisioned.status,
        // The accuracy metric. Which fields the model got wrong, per document.
        correctedFields: corrected,
        correctionCount: corrected.length,
        by: caller.name,
      },
      'purchase order confirmed from extraction',
    );
  },

  /**
   * Rejects an extraction.
   *
   * ── Why a note is required ────────────────────────────────────────────────
   * The rejections ARE the training data. "Not a purchase order — it was a
   * remittance advice" and "wrong account, this is Domain not Domaine" are
   * different failures, and a queue of bare rejections says only that the model
   * is wrong sometimes.
   */
  async reject(id: string, note: string, caller: Caller): Promise<void> {
    assertReviewer(caller);

    const trimmed = note.trim();
    if (!trimmed) {
      throw AppError.validation('Say why this is being rejected', [
        { path: 'note', message: 'A short reason — it is what improves the extraction' },
      ]);
    }

    const rejected = await poExtractionRepository.reject({
      id,
      note: trimmed,
      reviewedByUserId: caller.userId,
      reviewedBy: caller.name,
    });

    if (!rejected) {
      throw AppError.conflict(
        'That extraction is no longer awaiting review — reload the queue',
      );
    }

    log.info({ extractionId: id, note: trimmed, by: caller.name }, 'extraction rejected');
  },

  /** The nav badge. */
  async countNeedingReview(): Promise<number> {
    return poExtractionRepository.countNeedingReview();
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * A download URL for the stored original — but only if the bytes are still there.
 *
 * ── Why the existence check is worth the round trip ───────────────────────
 * Presigning is arithmetic: it signs a key whether or not anything lives at it,
 * and a URL over a missing object is indistinguishable from a working one until
 * the browser asks for it. The review screen then renders an embed that fails
 * silently — a grey panel, or "this browser will not display the PDF inline",
 * both of which read as a broken app rather than a missing file.
 *
 * `documentUrl: null` is already handled on the screen, and says the honest
 * thing: the text is all we have, check the source email. So the check converts
 * a confusing failure into an explained one.
 *
 * A storage outage returns null too. That is the right way round — telling a
 * reviewer the document is unavailable is better than handing them a link that
 * will not open.
 */
async function presignIfPresent(key: string | null): Promise<string | null> {
  if (!key) return null;

  try {
    const storage = getStorage();
    if (!(await storage.exists(key))) {
      log.warn({ key }, 'the stored purchase order is gone — showing the extracted text only');
      return null;
    }

    return await storage.presignDownload(key);
  } catch (error) {
    log.warn({ key, error: (error as Error).message }, 'could not presign the stored document');
    return null;
  }
}

/**
 * Why this extraction needs a human, decided server-side.
 *
 * ⚠️ Order matters: the FIRST true reason wins, and they are ordered by how
 * actionable they are. "No account match" is a more useful thing to tell a
 * reviewer than "not checked yet", even when both are true.
 */
async function resolveReason(input: IngestExtractionInput): Promise<IngestExtractionInput['reason']> {
  if (!input.suggestedAccountId) return 'no-account-match';

  if (input.accountCandidates.length > 1) {
    const [best, second] = input.accountCandidates;
    // Two candidates within a whisker of each other is ambiguity, not a match.
    if (best && second) return 'ambiguous-account';
  }

  if (
    input.poNumber &&
    (await poExtractionRepository.isDuplicate(input.suggestedAccountId, input.poNumber))
  ) {
    return 'duplicate-po';
  }

  /*
   * Nothing conflicted — and it STILL goes to a human. `no-job-match` is the
   * honest reason where there is no job: a purchase order arrives three to four
   * months before the work (Matt, 28:40), so there is usually nothing to attach
   * it to, and confirming which account it belongs to is a judgement nobody
   * should skip on a document that authorises invoicing.
   *
   * Otherwise it has simply not been read by anyone yet, which is what
   * `awaiting-check` says.
   */
  return input.suggestedJobId ? 'awaiting-check' : 'no-job-match';
}

/**
 * Which fields the human changed.
 *
 * This is the accuracy metric. Compared field by field against what was
 * extracted, so "the model reads areas well but supervisors badly" becomes a
 * number rather than an impression.
 */
function whatChanged(extraction: PoExtraction, input: PoConfirmation): string[] {
  const changed: string[] = [];

  const compare = (key: string, was: unknown, now: unknown): void => {
    // Loose on empty-vs-null: a blank the reviewer left alone is not a
    // correction, and counting it as one would inflate the error rate.
    const before = was === '' ? null : was;
    const after = now === '' ? null : now;
    if (before !== after) changed.push(key);
  };

  compare('poNumber', extraction.poNumber, input.poNumber);
  compare('accountId', extraction.suggestedAccountId, input.accountId);
  compare('expectedAreaM2', extraction.extractedAreaM2, input.expectedAreaM2);
  compare('bagAllowance', extraction.extractedBagAllowance, input.bagAllowance);
  compare('lotNumber', extraction.extractedLotNumber, input.lotNumber);
  compare('siteSupervisorName', extraction.extractedSupervisorName, input.siteSupervisorName);
  compare('siteSupervisorMobile', extraction.extractedSupervisorMobile, input.siteSupervisorMobile);
  compare('amountExGst', extraction.amountExGst, input.amountExGst);

  return changed;
}

function assertReviewer(caller: Caller): void {
  if (!caller.roles.some((role) => REVIEWER_ROLES.has(role))) {
    throw AppError.forbidden('Purchase-order review is for office staff');
  }
}
