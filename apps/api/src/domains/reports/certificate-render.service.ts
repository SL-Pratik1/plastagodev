import type { Certificate } from '@plastago/shared';
import { logger } from '../../lib/logger.js';
import { renderCertificatePdf } from '../../integrations/certificate-pdf.js';
import { buildKey, getStorage } from '../../integrations/storage.js';
import { settingsRepository } from '../settings/settings.repository.js';
import { reportRepository } from './report.repository.js';

const log = logger.child({ module: 'certificate-render' });

/**
 * Producing the Certificate of Recycling PDF (M9.5 · F52).
 *
 * ── Why this is its own service ───────────────────────────────────────────
 * Rendering needs two domains that the reporting service has no other reason
 * to know about — the settings that hold the branding and signature, and object
 * storage. Putting that inside `reportService` would give the reporting domain
 * a storage dependency for one method; putting it inside the renderer would
 * make a drawing module perform I/O.
 *
 * So this is the seam, exactly as `invoiceRenderService` is for invoices: it
 * READS from settings and storage, hands the renderer a flat snapshot, and
 * writes back exactly one thing — the storage key.
 */

/** Cached for a batch, because every certificate shares one set of branding. */
export interface CertificateRenderContext {
  branding: Awaited<ReturnType<typeof settingsRepository.get>>['invoicing'];
  logo: Uint8Array | null;
  signature: Uint8Array | null;
}

export const certificateRenderService = {
  /**
   * Build the context a batch of renders shares.
   *
   * ⚠️ Fetched ONCE per batch. The logo and the signature are storage round
   * trips, and doing them per certificate to draw the same two images is the
   * difference between a bulk render that finishes and one that times out.
   */
  async context(): Promise<CertificateRenderContext> {
    const settings = await settingsRepository.get();
    const branding = settings.invoicing;

    const [logo, signature] = await Promise.all([
      loadImage(branding.logoKey, 'logo'),
      loadImage(branding.certificateSignatureKey, 'signature'),
    ]);

    return { branding, logo, signature };
  },

  /**
   * Render one certificate and store the bytes. Returns the storage key.
   *
   * ⚠️ Called only AFTER the record has been issued, and that ordering is the
   * point. The figures are frozen by then, so the PDF and the record can never
   * disagree — a render of a draft would produce a document whose numbers were
   * still allowed to move.
   */
  async render(
    certificate: Certificate,
    context: CertificateRenderContext,
  ): Promise<string> {
    const pdf = await renderCertificatePdf({
      certificate,
      branding: context.branding,
      logo: context.logo,
      signature: context.signature,
    });

    const key = buildKey({
      scope: 'certificates',
      ownerId: certificate.id,
      kind: 'pdf',
      contentType: 'application/pdf',
    });

    await getStorage().put(key, pdf, 'application/pdf');
    await reportRepository.recordCertificatePdf(certificate.id, key);

    log.info(
      { certificateId: certificate.id, reference: certificate.reference, bytes: pdf.byteLength },
      'certificate pdf stored',
    );

    return key;
  },

  /**
   * The bytes to attach to an email: the stored PDF where one exists.
   *
   * ⚠️ The email must carry the document that IS the certificate, not a fresh
   * rendering of it. A customer who receives one copy by email and downloads
   * another from the portal must be holding the same file — otherwise "fixed at
   * issue", printed on both, is not true.
   */
  async bytesForSending(
    certificate: Certificate,
    context: CertificateRenderContext,
  ): Promise<Buffer | null> {
    try {
      const key =
        (await reportRepository.certificateStorageKey(certificate.id, null)) ??
        (await this.render(certificate, context));

      return await readAll(key);
    } catch (error) {
      /*
       * Never fatal. A PDF that could not be produced must not undo an issue
       * that is already written — the office can see the failure and resend,
       * and the certificate is in the portal either way.
       */
      log.error({ err: error, certificateId: certificate.id }, 'certificate pdf unavailable');
      return null;
    }
  },
};

/** Image bytes from storage, or null where there are none or they cannot be read. */
async function loadImage(key: string, what: 'logo' | 'signature'): Promise<Uint8Array | null> {
  if (key.trim() === '') return null;

  try {
    return await readAll(key);
  } catch (error) {
    // A missing image degrades the document; it never fails one.
    log.warn({ err: error, key, what }, 'certificate image could not be read');
    return null;
  }
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
