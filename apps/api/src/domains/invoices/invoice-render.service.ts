import type { Invoice } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { renderInvoicePdf } from '../../integrations/invoice-pdf.js';
import { buildKey, getStorage } from '../../integrations/storage.js';
import { accountRepository } from '../accounts/account.repository.js';
import { jobRepository } from '../jobs/job.repository.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { invoiceRepository } from './invoice.repository.js';

const log = logger.child({ module: 'invoice-render' });

/**
 * Producing the invoice PDF (M7.5, M7.6).
 *
 * ── Why this is its own service ───────────────────────────────────────────
 * Rendering needs four domains — the invoice, the account that names a
 * template, the settings that hold the branding, and the job that supplies the
 * site for the detailed layout. Putting that gathering inside `invoiceService`
 * would give the invoice domain a reason to import settings, accounts and jobs
 * for a concern none of them share; putting it inside the renderer would make
 * a drawing module perform I/O.
 *
 * So this is the seam: it READS from everywhere, hands the renderer a flat
 * snapshot, and writes back exactly one thing — the storage key.
 */

/** Cached for a batch, because fifty invoices share one set of branding. */
interface RenderContext {
  branding: Awaited<ReturnType<typeof settingsRepository.get>>['invoicing'];
  invoiceNumberPrefix: string;
  logo: Uint8Array | null;
}

export const invoiceRenderService = {
  /**
   * Build the context a batch of renders shares.
   *
   * ⚠️ Fetched ONCE per batch, not per invoice. The logo in particular is a
   * storage round trip, and doing it fifty times to draw the same image fifty
   * times is the difference between a bulk render that finishes and one that
   * times out.
   */
  async context(): Promise<RenderContext> {
    const settings = await settingsRepository.get();
    const branding = settings.invoicing;

    return {
      branding,
      invoiceNumberPrefix:
        branding.invoiceNumberPrefix === '' ? '' : `${branding.invoiceNumberPrefix}-`,
      logo: await loadLogo(branding.logoKey),
    };
  },

  /**
   * Render one invoice and store the bytes. Returns the storage key.
   *
   * Idempotent in the sense that matters: calling it twice produces two
   * objects and repoints the invoice at the newer one, which is what a
   * deliberate reissue should do. The OLD object is deliberately left in
   * place — see the note on `pdfKey`.
   */
  async render(invoice: Invoice, context: RenderContext): Promise<string> {
    const account = await accountRepository.findById(invoice.accountId, { accountId: null });

    const template = await settingsRepository.resolveTemplateFor(
      account?.invoiceTemplateId ?? null,
      invoice.brandId,
    );

    if (!template) {
      /*
       * No template for this brand at all. A configuration gap rather than a
       * request error, and refusing beats inventing a layout: an invoice that
       * went out on the wrong letterhead is not recallable.
       */
      throw AppError.dependencyUnavailable(
        `No invoice template is configured for ${invoice.brandId}. Add one in Settings before sending.`,
      );
    }

    const jobContext = await loadJobContext(invoice.jobId);

    const pdf = await renderInvoicePdf({
      invoice,
      template,
      branding: context.branding,
      invoiceNumberPrefix: context.invoiceNumberPrefix,
      logo: context.logo,
      jobContext,
    });

    const key = buildKey({
      scope: 'invoices',
      ownerId: invoice.id,
      kind: 'pdf',
      contentType: 'application/pdf',
    });

    await getStorage().put(key, pdf, 'application/pdf');

    /*
     * The template's NAME is frozen onto the invoice alongside the key.
     *
     * So a reprint says what it was printed on even after the template has
     * been renamed or deleted — `templateName` is a copy, not a join.
     */
    await invoiceRepository.recordPdf(invoice.id, {
      pdfKey: key,
      templateId: template.id,
      templateName: template.name,
    });

    log.info(
      { invoiceId: invoice.id, templateId: template.id, bytes: pdf.byteLength },
      'invoice pdf stored',
    );

    return key;
  },

  /**
   * Render for sending: reuse the stored PDF where one exists.
   *
   * ⚠️ The email must carry the document that IS the invoice, not a fresh
   * rendering of it. Where a PDF already exists this returns its bytes
   * unchanged, so a resend puts the identical file in front of the customer
   * rather than one re-derived from whatever settings say today.
   */
  async bytesForSending(invoice: Invoice, context: RenderContext): Promise<Buffer | null> {
    try {
      const key = invoice.pdfKey ?? (await this.render(invoice, context));
      return await readAll(key);
    } catch (error) {
      /*
       * Never fatal. A PDF that could not be produced must not stop the
       * invoice being sent or the status transition standing — the office can
       * see the failure and retry, and an email with no attachment still tells
       * the customer the invoice exists.
       */
      log.error({ err: error, invoiceId: invoice.id }, 'invoice pdf unavailable for sending');
      return null;
    }
  },
};

/** The logo bytes, or null where there is none or it cannot be read. */
async function loadLogo(key: string): Promise<Uint8Array | null> {
  if (key.trim() === '') return null;

  try {
    return await readAll(key);
  } catch (error) {
    // A missing logo degrades to the wordmark; it never fails an invoice.
    log.warn({ err: error, key }, 'invoice logo could not be read — falling back to text');
    return null;
  }
}

/** M7.5 — what the `detailed` layout prints about the collection. */
async function loadJobContext(jobId: string | null) {
  if (jobId === null) return null;

  const job = await jobRepository.findById(jobId, {
    accountId: null,
    bookedByUserId: null,
    driverId: null,
  });
  if (!job) return null;

  return {
    siteName: job.siteName,
    addressLine: job.addressLine,
    suburb: job.suburb,
    collectedOn: job.completedAt === null ? null : job.completedAt.slice(0, 10),
    recoveredWeightKg: job.recoveredWeightKg,
    expectedAreaM2: job.expectedAreaM2,
  };
}

/** Drain a storage stream into one buffer. */
async function readAll(key: string): Promise<Buffer> {
  const stream = await getStorage().get(key);
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  return Buffer.concat(chunks);
}
