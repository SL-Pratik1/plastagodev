import type {
  PortalTermsStatus,
  Role,
  TermsConfirm,
  TermsDocument,
  TermsLibrary,
  TermsSigning,
  TermsUploadRequest,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import {
  SETTINGS_OWNER,
  buildKey,
  getStorage,
  type PresignedUpload,
} from '../../integrations/storage.js';
import { renderSignedTerms } from '../../integrations/terms-pdf.js';
import { termsRepository, type TermsDocumentRow, type TermsSignatureRow } from './terms.repository.js';

const log = logger.child({ module: 'terms' });

/**
 * Terms and conditions (Matt, 21 Oct).
 *
 * *"I need a place where I can upload those terms, and them having to sign it,
 * and record… their agreeance and the IP address that they used to agree."*
 *
 * ── Who is asked ──────────────────────────────────────────────────────────
 * A customer ADMINISTRATOR, on an account opened with the onboarding tick on
 * (`termsRequired`), once there is a version to sign. Site supervisors are
 * never asked (decided 21 Oct). A newer version asks them again.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

/** Who uploads the terms — the same people who change settings. */
const UPLOAD_ROLES = new Set<Role>(['super-admin']);
/** Who reads the library and the signed copies — the office. */
const OFFICE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff']);

/**
 * The terms upload's key segment, checked on confirm. Anchored on both sides,
 * so a key from another upload (a logo, a template preview) cannot be passed
 * off as the terms.
 */
const TERMS_KEY_SEGMENT = /(^|\/)settings\/singleton\/terms\/[^/]+\.pdf$/;

/** A real drawn signature is a few kilobytes; nothing here should be bigger. */
const MAX_SIGNATURE_BYTES = 300 * 1024;

export const termsService = {
  /* ── The office ──────────────────────────────────────────────────────── */

  async library(caller: Caller): Promise<TermsLibrary> {
    assertOffice(caller);
    const versions = (await termsRepository.listDocuments()).map(toDocument);
    return { current: versions[0] ?? null, versions };
  },

  /**
   * Somewhere to PUT the PDF. Nothing changes until `confirmUpload` — an
   * abandoned upload leaves the current version exactly as it was.
   */
  async presignUpload(input: TermsUploadRequest, caller: Caller): Promise<PresignedUpload> {
    assertUploader(caller);

    const key = buildKey({
      scope: 'settings',
      ownerId: SETTINGS_OWNER,
      kind: 'terms',
      contentType: input.contentType,
    });

    return getStorage().presignUpload({
      key,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
  },

  /**
   * The bytes landed — they become the next version.
   *
   * ⚠️ Read back and checked for a PDF header before it is accepted. A key that
   * 404s means the PUT never finished, and a version customers are made to
   * "sign" that nobody can open is worse than no new version.
   */
  async confirmUpload(input: TermsConfirm, caller: Caller): Promise<TermsLibrary> {
    assertUploader(caller);

    if (!TERMS_KEY_SEGMENT.test(input.key)) {
      throw AppError.validation('That is not a terms upload', [
        { path: 'key', message: 'Upload the PDF again' },
      ]);
    }

    let head: Buffer;
    try {
      head = (await readAll(input.key)).subarray(0, 5);
    } catch {
      throw AppError.validation('The terms did not finish uploading', [
        { path: 'key', message: 'Try the upload again' },
      ]);
    }

    if (head.toString('latin1') !== '%PDF-') {
      throw AppError.validation('That file is not a PDF', [
        { path: 'key', message: 'Upload the terms as a PDF' },
      ]);
    }

    const created = await termsRepository.createDocument({
      fileName: input.fileName,
      storageKey: input.key,
      uploadedById: caller.userId,
      uploadedBy: caller.name,
    });
    if (!created) {
      throw AppError.conflict('Another version was uploaded at the same moment — reload and check');
    }

    log.info({ version: created.version, by: caller.name }, 'terms version uploaded');
    return this.library(caller);
  },

  /** A short-lived link to one version, for the office. */
  async documentUrl(version: number, caller: Caller): Promise<{ url: string }> {
    assertOffice(caller);
    const document = await termsRepository.findDocument(version);
    if (!document) throw AppError.notFound('No such version of the terms');
    return { url: await getStorage().presignDownload(document.storageKey) };
  },

  /**
   * What the customer signed: the terms with the signing page appended.
   * Drawn now if it could not be produced at signing — the evidence is the
   * record, the PDF is how it is read.
   */
  async signedCopyUrl(accountId: string, caller: Caller): Promise<{ url: string }> {
    assertOffice(caller);

    const signature = await termsRepository.latestSignature(accountId);
    if (!signature) throw AppError.notFound('This customer has not signed the terms');

    const key = signature.signedPdfKey ?? (await produceSignedCopy(signature));
    return { url: await getStorage().presignDownload(key) };
  },

  /* ── The portal ─────────────────────────────────────────────────────── */

  /**
   * Whether this caller must finish signing before using the portal.
   *
   * The one question the portal gate and the portal scope both ask, so the two
   * can never disagree about who is let in.
   */
  async pendingFor(caller: Caller): Promise<boolean> {
    if (!isCustomerAdmin(caller) || !caller.accountId) return false;

    const account = await termsRepository.accountTerms(caller.accountId);
    if (!account?.termsRequired) return false;

    const current = await termsRepository.currentDocument();
    // Nothing uploaded yet: there is nothing to sign, so nobody is held up.
    if (!current) return false;

    return !(account.detailsCompleted && (await termsRepository.hasSigned(caller.accountId, current.version)));
  },

  async status(caller: Caller): Promise<PortalTermsStatus> {
    const accountId = assertCustomerAdmin(caller);

    const [account, current, last] = await Promise.all([
      termsRepository.accountTerms(accountId),
      termsRepository.currentDocument(),
      termsRepository.latestSignature(accountId),
    ]);
    if (!account) throw AppError.notFound('Your account could not be found');

    return {
      required: await this.pendingFor(caller),
      detailsCompleted: account.detailsCompleted,
      current: current ? toDocument(current) : null,
      signedVersion: last?.version ?? null,
      lastDirector: last ? { name: last.directorName, address: last.directorAddress } : null,
      signed: last
        ? { version: last.version, signedAt: last.signedAt.toISOString(), signerName: last.signerName }
        : null,
    };
  },

  /**
   * The customer's own signed copy — the same document the office downloads
   * (23 Oct). Their account only: the id comes from the session, never the URL.
   */
  async mySignedCopyUrl(caller: Caller): Promise<{ url: string }> {
    const accountId = assertCustomerAdmin(caller);

    const signature = await termsRepository.latestSignature(accountId);
    if (!signature) throw AppError.notFound('Your account has not signed the terms online');

    const key = signature.signedPdfKey ?? (await produceSignedCopy(signature));
    return { url: await getStorage().presignDownload(key) };
  },

  /** The current version, for the customer to open and read before signing. */
  async currentDocumentUrl(caller: Caller): Promise<{ url: string; fileName: string; version: number }> {
    assertCustomerAdmin(caller);
    const current = await termsRepository.currentDocument();
    if (!current) throw AppError.notFound('There are no terms to read yet');

    return {
      url: await getStorage().presignDownload(current.storageKey),
      fileName: current.fileName,
      version: current.version,
    };
  },

  /**
   * The customer signs the current version, with the director's guarantee.
   *
   * Records the typed name, both drawn signatures, the time, the IP and the
   * browser, and produces the signed copy the office downloads.
   */
  async sign(
    input: TermsSigning,
    caller: Caller,
    request: { ip: string | null; userAgent: string | null },
  ): Promise<PortalTermsStatus> {
    const accountId = assertCustomerAdmin(caller);

    const [account, current] = await Promise.all([
      termsRepository.accountTerms(accountId),
      termsRepository.currentDocument(),
    ]);
    if (!account) throw AppError.notFound('Your account could not be found');
    if (!current) throw AppError.conflict('There are no terms to sign yet');

    // They read one version; a newer one went up meanwhile. Sign what you read.
    if (input.version !== current.version) {
      throw AppError.conflict('The terms were updated while you were reading — open the new version and sign again');
    }
    if (!account.detailsCompleted) {
      throw AppError.conflict('Complete your company details first — they are step 1');
    }

    const signature = decodeSignature(input.signature, 'signature');
    const directorSignature = decodeSignature(input.directorSignature, 'directorSignature');

    const [signatureKey, directorSignatureKey] = await Promise.all([
      storeSignature(accountId, signature),
      storeSignature(accountId, directorSignature),
    ]);

    const signedAt = new Date();
    const id = await termsRepository.createSignature({
      accountId,
      userId: caller.userId,
      version: current.version,
      signedAt,
      signerName: input.signerName,
      signatureKey,
      directorName: input.directorName,
      directorAddress: input.directorAddress,
      directorSignatureKey,
      ip: request.ip,
      userAgent: request.userAgent?.slice(0, 400) ?? null,
    });
    if (!id) {
      throw AppError.conflict('Your account has already signed this version of the terms');
    }

    log.info(
      { accountId, version: current.version, by: caller.name, ip: request.ip },
      'terms signed',
    );

    /*
     * The signed copy, best-effort. The record above IS the acceptance; if the
     * PDF cannot be drawn now it is drawn on first download instead.
     */
    const saved = await termsRepository.latestSignature(accountId);
    if (saved) {
      await produceSignedCopy(saved).catch((error: unknown) => {
        log.error({ err: error, accountId }, 'signed copy of the terms could not be produced yet');
      });
    }

    return this.status(caller);
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function toDocument(row: TermsDocumentRow): TermsDocument {
  return {
    version: row.version,
    fileName: row.fileName,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: row.uploadedBy,
  };
}

/** A drawn signature arrives as a PNG data URL; it leaves as PNG bytes. */
function decodeSignature(dataUrl: string, path: 'signature' | 'directorSignature'): Buffer {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

  if (!isPng || bytes.length > MAX_SIGNATURE_BYTES) {
    throw AppError.validation('That signature could not be read', [
      { path, message: 'Clear it and sign again' },
    ]);
  }
  return bytes;
}

async function storeSignature(accountId: string, bytes: Buffer): Promise<string> {
  const key = buildKey({ scope: 'accounts', ownerId: accountId, kind: 'signatures', contentType: 'image/png' });
  await getStorage().put(key, bytes, 'image/png');
  return key;
}

/** Draws and stores the signed copy, and records where it went. */
async function produceSignedCopy(signature: TermsSignatureRow): Promise<string> {
  const [account, document, signaturePng, directorPng] = await Promise.all([
    termsRepository.accountTerms(signature.accountId),
    termsRepository.findDocument(signature.version),
    readAll(signature.signatureKey),
    readAll(signature.directorSignatureKey),
  ]);

  const termsPdf = document ? await readAll(document.storageKey).catch(() => null) : null;

  const pdf = await renderSignedTerms({
    termsPdf,
    termsVersion: signature.version,
    termsFileName: document?.fileName ?? `version ${String(signature.version)}`,
    accountName: account?.name ?? 'Customer',
    customerCode: account?.code ?? '',
    signerName: signature.signerName,
    signedAt: signature.signedAt,
    ip: signature.ip,
    userAgent: signature.userAgent,
    signature: signaturePng,
    directorName: signature.directorName,
    directorAddress: signature.directorAddress,
    directorSignature: directorPng,
  });

  const key = buildKey({
    scope: 'accounts',
    ownerId: signature.accountId,
    kind: 'terms-signed',
    contentType: 'application/pdf',
  });
  await getStorage().put(key, pdf, 'application/pdf');
  await termsRepository.setSignedPdfKey(signature.id, key);
  return key;
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

function isCustomerAdmin(caller: Caller): boolean {
  return caller.roles.includes('customer-administrator');
}

/**
 * Decided 21 Oct: only customer administrators sign — never a site supervisor.
 * Returns the account they sign for.
 */
function assertCustomerAdmin(caller: Caller): string {
  if (!isCustomerAdmin(caller) || !caller.accountId) {
    throw AppError.forbidden('Only your account administrator signs the terms');
  }
  return caller.accountId;
}

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => OFFICE_ROLES.has(role))) {
    throw AppError.forbidden('The terms library is for the office');
  }
}

function assertUploader(caller: Caller): void {
  if (!caller.roles.some((role) => UPLOAD_ROLES.has(role))) {
    throw AppError.forbidden('Only a Super Admin can upload the terms');
  }
}
