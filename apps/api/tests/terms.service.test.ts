import { Readable } from 'node:stream';
import type { Role } from '@plastago/shared';
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Terms and conditions (Matt, 21 Oct).
 *
 * *"I need a place where I can upload those terms, and them having to sign it,
 * and record… their agreeance and the IP address that they used to agree."*
 *
 * What is pinned here: who is asked (and who never is), that a newer version
 * asks again, that the signing records the evidence, and that the signed copy
 * is the terms with the signing page appended.
 */

const ACCOUNT = 'acc0000000000000000000a1';

/* ── In-memory stand-ins ─────────────────────────────────────────────────── */

const objects = new Map<string, Buffer>();
let documents: Array<{
  version: number;
  fileName: string;
  storageKey: string;
  uploadedAt: Date;
  uploadedById: string;
  uploadedBy: string;
}> = [];
let signatures: Array<Record<string, unknown> & { id: string; accountId: string; version: number; signedAt: Date }> = [];
let account = { name: 'Clarendon Homes', code: 'CLA001', termsRequired: true, detailsCompleted: true };

vi.mock('../src/integrations/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/storage.js')>();
  return {
    ...actual,
    getStorage: () => ({
      presignUpload: (input: { key: string }) =>
        Promise.resolve({ key: input.key, uploadUrl: `https://storage.test/${input.key}`, headers: {}, expiresAt: new Date().toISOString() }),
      presignDownload: (key: string) => Promise.resolve(`https://storage.test/${key}?signed`),
      put: (key: string, body: Buffer) => {
        objects.set(key, body);
        return Promise.resolve();
      },
      get: (key: string) => {
        const body = objects.get(key);
        return body ? Promise.resolve(Readable.from([body])) : Promise.reject(new Error('NoSuchKey'));
      },
      remove: () => Promise.resolve(),
      exists: (key: string) => Promise.resolve(objects.has(key)),
    }),
  };
});

vi.mock('../src/domains/terms/terms.repository.js', () => ({
  termsRepository: {
    currentDocument: () => Promise.resolve(documents.at(-1) ?? null),
    findDocument: (version: number) => Promise.resolve(documents.find((d) => d.version === version) ?? null),
    listDocuments: () => Promise.resolve([...documents].reverse()),
    createDocument: (input: { fileName: string; storageKey: string; uploadedById: string; uploadedBy: string }) => {
      const row = { ...input, version: documents.length + 1, uploadedAt: new Date() };
      documents.push(row);
      return Promise.resolve(row);
    },
    accountTerms: () => Promise.resolve({ ...account }),
    latestSignature: (accountId: string) =>
      Promise.resolve(
        [...signatures].reverse().find((s) => s.accountId === accountId) ?? null,
      ),
    hasSigned: (accountId: string, version: number) =>
      Promise.resolve(signatures.some((s) => s.accountId === accountId && s.version === version)),
    createSignature: (input: Record<string, unknown> & { accountId: string; version: number; signedAt: Date }) => {
      if (signatures.some((s) => s.accountId === input.accountId && s.version === input.version)) {
        return Promise.resolve(null);
      }
      const id = String(signatures.length + 1).padStart(24, '0');
      signatures.push({ ...input, id, signedPdfKey: null });
      return Promise.resolve(id);
    },
    setSignedPdfKey: (id: string, key: string) => {
      const row = signatures.find((s) => s.id === id);
      if (row) row.signedPdfKey = key;
      return Promise.resolve();
    },
  },
}));

const { termsService } = await import('../src/domains/terms/terms.service.js');
const { isOpenBeforeSigning } = await import('../src/domains/terms/terms.gate.js');

const ADMIN = { userId: 'usr0000000000000000000a1', name: 'Matt Smith', roles: ['super-admin'] as Role[], accountId: null };
const OPERATIONS = { ...ADMIN, name: 'Renee Alvarez', roles: ['operations'] as Role[] };
const CUSTOMER_ADMIN = {
  userId: 'usr0000000000000000000c1',
  name: 'Angela Fitzgerald',
  roles: ['customer-administrator'] as Role[],
  accountId: ACCOUNT,
};
const SUPERVISOR = { ...CUSTOMER_ADMIN, userId: 'usr0000000000000000000s1', roles: ['customer-site-supervisor'] as Role[] };

/** A 1×1 PNG, as a canvas would export one. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

async function uploadTerms(pages = 2): Promise<void> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage();
  const key = `settings/singleton/terms/${String(documents.length + 1)}.pdf`;
  objects.set(key, Buffer.from(await pdf.save()));
  await termsService.confirmUpload({ key, fileName: `PlastaGo terms v${String(documents.length + 1)}.pdf` }, ADMIN);
}

function signing(overrides: Record<string, unknown> = {}) {
  return {
    version: documents.at(-1)?.version ?? 1,
    directorName: 'Abdo Haddad',
    directorAddress: '12 Kembla Street, Wollongong NSW 2500',
    directorSignature: PNG,
    signerName: 'Angela Fitzgerald',
    signature: PNG,
    hasReadTerms: true as const,
    ...overrides,
  };
}

const REQUEST = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (QA)' };

beforeEach(() => {
  objects.clear();
  documents = [];
  signatures = [];
  account = { name: 'Clarendon Homes', code: 'CLA001', termsRequired: true, detailsCompleted: true };
});

describe('uploading the terms (Settings)', () => {
  it('versions every upload — the newest is the one customers sign', async () => {
    await uploadTerms();
    await uploadTerms();

    const library = await termsService.library(OPERATIONS);

    expect(library.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(library.current).toMatchObject({ version: 2, uploadedBy: 'Matt Smith' });
    // Who uploaded it is linked by their user id, not only their name.
    expect(documents.at(-1)?.uploadedById).toBe(ADMIN.userId);
  });

  it('refuses a file that is not a PDF', async () => {
    objects.set('settings/singleton/terms/x.pdf', Buffer.from('not a pdf'));

    await expect(
      termsService.confirmUpload({ key: 'settings/singleton/terms/x.pdf', fileName: 'x.pdf' }, ADMIN),
    ).rejects.toMatchObject({ status: 422 });
    expect(documents).toHaveLength(0);
  });

  it('refuses a key from another upload, and one that never landed', async () => {
    await expect(
      termsService.confirmUpload({ key: 'settings/singleton/logo/x.png', fileName: 'x.pdf' }, ADMIN),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      termsService.confirmUpload({ key: 'settings/singleton/terms/missing.pdf', fileName: 'x.pdf' }, ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lets only a Super Admin upload', async () => {
    await expect(
      termsService.presignUpload({ contentType: 'application/pdf', contentLength: 1000 }, OPERATIONS),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('who is asked to sign', () => {
  it('a customer administrator on an account opened with the onboarding tick', async () => {
    await uploadTerms();
    expect(await termsService.pendingFor(CUSTOMER_ADMIN)).toBe(true);
  });

  it('nobody when the tick was off — already covered by a signed contract', async () => {
    await uploadTerms();
    account.termsRequired = false;
    expect(await termsService.pendingFor(CUSTOMER_ADMIN)).toBe(false);
  });

  it('never a site supervisor', async () => {
    await uploadTerms();
    expect(await termsService.pendingFor(SUPERVISOR)).toBe(false);
  });

  it('nobody before any terms are uploaded — there is nothing to sign', async () => {
    expect(await termsService.pendingFor(CUSTOMER_ADMIN)).toBe(false);
  });

  it('asks again when a newer version is uploaded', async () => {
    await uploadTerms();
    await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);
    expect(await termsService.pendingFor(CUSTOMER_ADMIN)).toBe(false);

    await uploadTerms();
    expect(await termsService.pendingFor(CUSTOMER_ADMIN)).toBe(true);
  });
});

describe('signing', () => {
  it('records the names, both signatures, the time, the IP, the browser and the version', async () => {
    await uploadTerms();

    const status = await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);

    expect(status).toMatchObject({ required: false, signedVersion: 1 });
    expect(signatures[0]).toMatchObject({
      accountId: ACCOUNT,
      version: 1,
      signerName: 'Angela Fitzgerald',
      directorName: 'Abdo Haddad',
      directorAddress: '12 Kembla Street, Wollongong NSW 2500',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (QA)',
    });
    expect(objects.has(String(signatures[0]?.signatureKey))).toBe(true);
    expect(objects.has(String(signatures[0]?.directorSignatureKey))).toBe(true);
  });

  it('produces the signed copy: the terms with a signing page appended', async () => {
    await uploadTerms(2);
    await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);

    const copy = objects.get(String(signatures[0]?.signedPdfKey));
    expect(copy).toBeDefined();
    const pdf = await PDFDocument.load(copy ?? Buffer.alloc(0));
    expect(pdf.getPageCount()).toBe(3);

    const { url } = await termsService.signedCopyUrl(ACCOUNT, OPERATIONS);
    expect(url).toContain(String(signatures[0]?.signedPdfKey));
  });

  it('refuses a version that is no longer current', async () => {
    await uploadTerms();
    await uploadTerms();

    await expect(
      termsService.sign(signing({ version: 1 }), CUSTOMER_ADMIN, REQUEST),
    ).rejects.toMatchObject({ status: 409 });
    expect(signatures).toHaveLength(0);
  });

  it('refuses before the company details are completed — they are step 1', async () => {
    await uploadTerms();
    account.detailsCompleted = false;

    await expect(termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a site supervisor', async () => {
    await uploadTerms();
    await expect(termsService.sign(signing(), SUPERVISOR, REQUEST)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses signing the same version twice', async () => {
    await uploadTerms();
    await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);

    await expect(termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a signature that is not a PNG', async () => {
    await uploadTerms();

    await expect(
      termsService.sign(signing({ signature: 'data:image/png;base64,bm90IGFuIGltYWdl' }), CUSTOMER_ADMIN, REQUEST),
    ).rejects.toMatchObject({ status: 422 });
    expect(signatures).toHaveLength(0);
  });
});

describe('the portal gate', () => {
  it('leaves the signing steps open and closes everything else', () => {
    expect(isOpenBeforeSigning('/scope')).toBe(true);
    expect(isOpenBeforeSigning('/onboarding')).toBe(true);
    expect(isOpenBeforeSigning('/terms/sign')).toBe(true);
    expect(isOpenBeforeSigning('/jobs')).toBe(false);
    expect(isOpenBeforeSigning('/invoices')).toBe(false);
  });
});

/** The customer's own signed copy, on their portal Account page (23 Oct). */
describe('their own signed terms, in the portal (23 Oct)', () => {
  it('shows who signed which version, and hands them their signed copy', async () => {
    await uploadTerms();
    await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);

    const status = await termsService.status(CUSTOMER_ADMIN);
    expect(status.signed).toMatchObject({ version: 1, signerName: 'Angela Fitzgerald' });

    const { url } = await termsService.mySignedCopyUrl(CUSTOMER_ADMIN);
    expect(url).toContain(String(signatures[0]?.signedPdfKey));
  });

  it('says plainly when the account has never signed online', async () => {
    await uploadTerms();

    expect((await termsService.status(CUSTOMER_ADMIN)).signed).toBeNull();
    await expect(termsService.mySignedCopyUrl(CUSTOMER_ADMIN)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a site supervisor — the terms are for the account administrator', async () => {
    await uploadTerms();
    await termsService.sign(signing(), CUSTOMER_ADMIN, REQUEST);

    await expect(termsService.mySignedCopyUrl(SUPERVISOR)).rejects.toMatchObject({ status: 403 });
  });
});
