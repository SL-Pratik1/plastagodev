import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, Settings } from '@plastago/shared';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Invoice branding and templates (M7.5).
 *
 * ── What these protect ───────────────────────────────────────────────────
 * The document a builder's accounts department receives. Two failure modes
 * matter and neither is visible on the settings screen that caused them:
 *
 *  • **A document that is not a valid tax invoice.** No ABN means the
 *    customer may lawfully withhold payment, and nobody finds out until the
 *    money does not arrive.
 *  • **A template that disappears under an account.** Deleting one silently
 *    moves that builder onto a different letterhead, weeks after the change.
 */

let repo: ReturnType<typeof createFakeSettingsRepository>;

// A GETTER, not a value: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return repo.repository;
  },
}));

/** Keys the fake bucket holds. `confirmLogo` reads one back before accepting it. */
let storedObjects = new Set<string>();
const removedObjects: string[] = [];

/*
 * The bucket, faked.
 *
 * ⚠️ Not optional. `confirmLogo` deliberately READS the object back before it
 * will store the key — an upload that never finished must not be able to
 * replace a working logo with a blank space on every invoice. Without a fake
 * here the real provider reaches for S3 and every confirm fails that check,
 * which is what the first run of these tests did.
 */
vi.mock('../src/integrations/storage.js', () => ({
  SETTINGS_OWNER: 'singleton',
  buildKey: (input: { scope: string; ownerId: string; kind: string }) =>
    `plastago/${input.scope}/${input.ownerId}/${input.kind}/test.png`,
  getStorage: () => ({
    presignUpload: ({ key }: { key: string }) =>
      Promise.resolve({
        key,
        uploadUrl: `http://storage.test/${key}`,
        headers: {},
        expiresAt: '2026-09-15T00:00:00.000Z',
      }),
    presignDownload: (key: string) => Promise.resolve(`http://storage.test/${key}?signed`),
    get: (key: string) =>
      storedObjects.has(key)
        ? Promise.resolve(null)
        : Promise.reject(new Error('no such object')),
    put: (key: string) => {
      storedObjects.add(key);
      return Promise.resolve();
    },
    remove: (key: string) => {
      removedObjects.push(key);
      storedObjects.delete(key);
      return Promise.resolve();
    },
  }),
}));

const { settingsService } = await import('../src/domains/settings/settings.service.js');

const ADMIN = { roles: ['super-admin'] as Role[], accountId: null };
const OFFICE = { roles: ['office-staff'] as Role[], accountId: null };

beforeEach(() => {
  repo = createFakeSettingsRepository();
  storedObjects = new Set();
  removedObjects.length = 0;
});

function invoicing(overrides: Partial<Settings['invoicing']> = {}): Settings['invoicing'] {
  return { ...repo.current().invoicing, ...overrides };
}

/* ── Branding ────────────────────────────────────────────────────────────── */

describe('invoice branding', () => {
  it('saves the company details the PDF prints', async () => {
    const saved = await settingsService.saveInvoicing(
      invoicing({ companyName: 'PlastaGo Group Pty Ltd', companyPhone: '02 9111 2222' }),
      ADMIN,
    );

    expect(saved.companyName).toBe('PlastaGo Group Pty Ltd');
    expect(saved.companyPhone).toBe('02 9111 2222');
  });

  /*
   * ⚠️ An ABN is what makes the document a TAX invoice. A customer is
   * entitled to withhold payment on one without it, so a malformed value is
   * refused rather than printed.
   */
  it('refuses an ABN that is not eleven digits', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ companyAbn: '5182475' }), ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'companyAbn' }] });
  });

  it('accepts an ABN typed with spaces, the way it appears on paper', async () => {
    const saved = await settingsService.saveInvoicing(
      invoicing({ companyAbn: '51 824 753 556' }),
      ADMIN,
    );

    // Stored as typed — formatting is the renderer's job, not the store's.
    expect(saved.companyAbn).toBe('51 824 753 556');
  });

  it('allows a blank ABN, because a fresh environment has none yet', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ companyAbn: '', companyName: '' }), ADMIN),
    ).resolves.toBeDefined();
  });

  it('refuses an ABN with no company name to attach it to', async () => {
    // Half a letterhead is worse than none: it looks finished.
    await expect(
      settingsService.saveInvoicing(
        invoicing({ companyAbn: '51824753556', companyName: '  ' }),
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'companyName' }] });
  });

  /*
   * The payer's own banking software asks for the account name. An invoice
   * that omits it generates a phone call on every first payment.
   */
  it('refuses bank details with no account name', async () => {
    await expect(
      settingsService.saveInvoicing(
        invoicing({ bankBsb: '082-343', bankAccount: '45 327 0863', bankAccountName: '' }),
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'bankAccountName' }] });
  });

  it('still refuses a BSB with no account number', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ bankAccount: '' }), ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'bankAccount' }] });
  });

  it('allows every payment field blank together', async () => {
    await expect(
      settingsService.saveInvoicing(
        invoicing({ bankBsb: '', bankAccount: '', bankAccountName: '' }),
        ADMIN,
      ),
    ).resolves.toMatchObject({ bankBsb: '' });
  });

  it('refuses a non-administrator', async () => {
    await expect(settingsService.saveInvoicing(invoicing(), OFFICE)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.calls.savedInvoicing).toBeNull();
  });
});

/* ── Templates ───────────────────────────────────────────────────────────── */

describe('invoice templates', () => {
  const newTemplate = {
    name: 'Metricon Invoice',
    brandId: 'plastago' as const,
    showsWeight: true,
    layout: 'detailed' as const,
    accentColour: '#1a4d3a',
  };

  it('creates one, deriving the id from the name', async () => {
    const created = await settingsService.createInvoiceTemplate(newTemplate, ADMIN);

    expect(created.id).toBe('metricon-invoice');
    expect(created.layout).toBe('detailed');
    expect(repo.calls.createdTemplates).toEqual(['metricon-invoice']);
  });

  it('refuses a name that cannot become an id', async () => {
    await expect(
      settingsService.createInvoiceTemplate({ ...newTemplate, name: '///' }, ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'name' }] });

    expect(repo.calls.createdTemplates).toEqual([]);
  });

  it('refuses a duplicate', async () => {
    await settingsService.createInvoiceTemplate(newTemplate, ADMIN);

    await expect(
      settingsService.createInvoiceTemplate(newTemplate, ADMIN),
    ).rejects.toMatchObject({ status: 409 });

    expect(repo.calls.createdTemplates).toHaveLength(1);
  });

  it('renames and recolours one', async () => {
    const updated = await settingsService.updateInvoiceTemplate(
      'pg-m2',
      { ...newTemplate, name: 'PlastaGo Standard', accentColour: '#0f5c7a' },
      ADMIN,
    );

    expect(updated.name).toBe('PlastaGo Standard');
    expect(updated.accentColour).toBe('#0f5c7a');
  });

  it('404s on a template that does not exist', async () => {
    await expect(
      settingsService.updateInvoiceTemplate('no-such-template', newTemplate, ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });

  /*
   * ⚠️ The guard that matters. Deleting a template an account names would
   * move that builder onto a different letterhead silently — and nobody would
   * connect "why does this invoice look different?" to a settings change made
   * weeks earlier.
   */
  it('refuses to delete a template accounts still invoice on', async () => {
    repo.assignTemplate('pg-m2', 4);

    await expect(settingsService.deleteInvoiceTemplate('pg-m2', ADMIN)).rejects.toMatchObject({
      status: 409,
    });

    expect(repo.calls.deletedTemplates).toEqual([]);
  });

  it('deletes one nothing references', async () => {
    await settingsService.createInvoiceTemplate(newTemplate, ADMIN);
    await settingsService.deleteInvoiceTemplate('metricon-invoice', ADMIN);

    expect(repo.calls.deletedTemplates).toEqual(['metricon-invoice']);
  });

  it('404s when deleting one that does not exist', async () => {
    await expect(
      settingsService.deleteInvoiceTemplate('no-such-template', ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a non-administrator on every write', async () => {
    await expect(
      settingsService.createInvoiceTemplate(newTemplate, OFFICE),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      settingsService.updateInvoiceTemplate('pg-m2', newTemplate, OFFICE),
    ).rejects.toMatchObject({ status: 403 });

    await expect(settingsService.deleteInvoiceTemplate('pg-m2', OFFICE)).rejects.toMatchObject({
      status: 403,
    });

    expect(repo.calls.createdTemplates).toEqual([]);
    expect(repo.calls.deletedTemplates).toEqual([]);
  });
});

/* ── Resolution ──────────────────────────────────────────────────────────── */

describe('resolving which template an invoice prints on', () => {
  it('uses the one the account names', async () => {
    await settingsService.createInvoiceTemplate(
      {
        name: 'Clarendon Invoice',
        brandId: 'plastago',
        showsWeight: false,
        layout: 'compact',
        accentColour: '#1a4d3a',
      },
      ADMIN,
    );

    const resolved = await repo.repository.resolveTemplateFor('clarendon-invoice', 'plastago');
    expect(resolved?.id).toBe('clarendon-invoice');
  });

  /*
   * ⚠️ The fallback is by BRAND, not "the first row".
   *
   * An account with nothing chosen still has to render, and falling back to
   * whatever sorted first would put an EasyLift invoice on PlastaGo
   * letterhead — visibly wrong to the customer, invisible to us.
   */
  it('falls back within the brand when the account names nothing', async () => {
    await settingsService.createInvoiceTemplate(
      {
        name: 'EasyLift Invoice',
        brandId: 'easylift',
        showsWeight: false,
        layout: 'standard',
        accentColour: '#0f5c7a',
      },
      ADMIN,
    );

    const resolved = await repo.repository.resolveTemplateFor(null, 'easylift');
    expect(resolved?.brandId).toBe('easylift');
  });

  it('falls back by brand when the named template has since been deleted', async () => {
    // The account still points at a dead id. It must render, on its own brand.
    const resolved = await repo.repository.resolveTemplateFor('deleted-template', 'plastago');
    expect(resolved?.brandId).toBe('plastago');
  });

  it('returns null when the brand has no template at all', async () => {
    /*
     * A configuration gap, and the render service turns it into a refusal
     * rather than guessing. An invoice on the wrong letterhead is not
     * recallable.
     */
    const resolved = await repo.repository.resolveTemplateFor(null, 'brickgo');
    expect(resolved).toBeNull();
  });
});

/* ── M7.5 · the logo ─────────────────────────────────────────────────────── */

describe('the invoice logo', () => {
  const LOGO_KEY = 'plastago/settings/singleton/logo/abc.png';

  it('hands back somewhere to PUT the bytes, without changing the logo yet', async () => {
    const ticket = await settingsService.presignLogo(
      { contentType: 'image/png', contentLength: 4_096 },
      ADMIN,
    );

    expect(ticket.uploadUrl).toContain('http');
    /*
     * ⚠️ The point of the test. An upload the browser then abandons must leave
     * the invoices printing whatever logo they had — so nothing is stored until
     * the confirm.
     */
    expect(repo.calls.logoKeys).toEqual([]);
  });

  it('stores the key once the bytes are confirmed', async () => {
    storedObjects.add(LOGO_KEY);

    await settingsService.confirmLogo(LOGO_KEY, ADMIN);

    expect(repo.calls.logoKeys).toEqual([LOGO_KEY]);
  });

  /*
   * The key comes back from a client, so it is checked. Without this, a caller
   * could point the invoice logo at any object in the bucket — a docket photo,
   * or a customer's purchase order document.
   */
  it('refuses a key from outside the logo’s own prefix', async () => {
    await expect(
      settingsService.confirmLogo('plastago/jobs/000000000000000000000000/photos/x.png', ADMIN),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.calls.logoKeys).toEqual([]);
  });

  /*
   * ⚠️ A QA find. The first version of the check matched on "settings"
   * anywhere in the key, which admitted a template PREVIEW — and a PDF stored
   * as the logo cannot be embedded, so the renderer falls back to text and
   * every invoice silently loses its mark with nothing reporting an error.
   */
  it('refuses a template preview posing as a logo', async () => {
    storedObjects.add('plastago/settings/singleton/template-preview/x.pdf');

    await expect(
      settingsService.confirmLogo('plastago/settings/singleton/template-preview/x.pdf', ADMIN),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.calls.logoKeys).toEqual([]);
  });

  /* Deployments without an S3 key prefix produce keys with no leading segment. */
  it('accepts an unprefixed logo key', async () => {
    storedObjects.add('settings/singleton/logo/abc.png');

    await settingsService.confirmLogo('settings/singleton/logo/abc.png', ADMIN);

    expect(repo.calls.logoKeys).toEqual(['settings/singleton/logo/abc.png']);
  });

  it('clears the key when the logo is removed', async () => {
    storedObjects.add(LOGO_KEY);

    await settingsService.confirmLogo(LOGO_KEY, ADMIN);
    await settingsService.removeLogo(ADMIN);

    expect(repo.calls.logoKeys).toEqual([LOGO_KEY, '']);
    // The bytes go too — an unreferenced logo is just cost.
    expect(removedObjects).toEqual([LOGO_KEY]);
  });

  /*
   * ⚠️ The refusal that protects the invoices. A PUT that never landed leaves
   * the previous logo in place rather than replacing it with a dead key, which
   * the renderer would degrade to plain text — silently, on every invoice.
   */
  it('refuses a key whose bytes never arrived', async () => {
    await expect(settingsService.confirmLogo(LOGO_KEY, ADMIN)).rejects.toMatchObject({
      status: 422,
    });

    expect(repo.calls.logoKeys).toEqual([]);
  });

  it('refuses a non-administrator', async () => {
    await expect(
      settingsService.presignLogo({ contentType: 'image/png', contentLength: 10 }, OFFICE),
    ).rejects.toMatchObject({ status: 403 });

    await expect(settingsService.removeLogo(OFFICE)).rejects.toMatchObject({ status: 403 });
  });
});
