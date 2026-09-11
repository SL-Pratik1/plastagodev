import { SettingsSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, Settings } from '@plastago/shared';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Settings rules (M2.4).
 *
 * These test the things a repository cannot: who may change a platform-wide
 * setting, and what is refused outright. Both are decisions, and both are the
 * kind that get quietly reimplemented in a controller if they are not pinned
 * here.
 *
 * ⚠️ Notification rules, credential types and integration checks were removed —
 * each wrote a value nothing downstream read — so the write-permission cases
 * below run through invoicing rather than spreading across four sections.
 *
 * Pricing is the other writable section, and its rules are the sharpest in the
 * codebase: a rate that can be edited in place reprices work that has already
 * been invoiced. See "issuing a rate schedule" below.
 */

let repo: ReturnType<typeof createFakeSettingsRepository>;

// A GETTER, not a value: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return repo.repository;
  },
}));

const { settingsService } = await import('../src/domains/settings/settings.service.js');

const ADMIN = { roles: ['super-admin'] as Role[], accountId: null };
const OPS = { roles: ['operations'] as Role[], accountId: null };
const OFFICE = { roles: ['office-staff'] as Role[], accountId: null };
const CUSTOMER = { roles: ['customer-administrator'] as Role[], accountId: 'a'.repeat(24) };

beforeEach(() => {
  repo = createFakeSettingsRepository();
});

describe('who may read settings', () => {
  it('lets office staff read them', async () => {
    // The additional-service prices are on screen while the office books a job,
    // so making this admin-only would hide the rules they work to.
    const settings = await settingsService.get(OFFICE);
    expect(settings.pricing.additionalServices.length).toBeGreaterThan(0);
    expect(settings.invoicing.defaultPaymentTermsDays).toBe(7);
  });

  it('refuses a customer outright', async () => {
    await expect(settingsService.get(CUSTOMER)).rejects.toMatchObject({ status: 403 });
  });

  it('returns a shape the contract accepts', async () => {
    const settings = await settingsService.get(ADMIN);
    expect(() => SettingsSchema.parse(settings)).not.toThrow();
  });
});

describe('who may change them', () => {
  it('allows an administrator', async () => {
    const saved = await settingsService.saveInvoicing(
      { ...repo.current().invoicing, defaultPaymentTermsDays: 14 },
      ADMIN,
    );
    expect(saved.defaultPaymentTermsDays).toBe(14);
  });

  it('allows operations', async () => {
    const saved = await settingsService.saveInvoicing(
      { ...repo.current().invoicing, defaultPaymentTermsDays: 30 },
      OPS,
    );
    expect(saved.defaultPaymentTermsDays).toBe(30);
  });

  it('refuses office staff, who may read but not write', async () => {
    // The blast radius of a wrong setting is every job afterwards.
    await expect(
      settingsService.saveInvoicing(repo.current().invoicing, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.calls.savedInvoicing).toBeNull();
  });

  it('refuses a customer', async () => {
    await expect(
      settingsService.saveInvoicing(repo.current().invoicing, CUSTOMER),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.calls.savedInvoicing).toBeNull();
  });

  it('refuses on the permission check, before any validation runs', async () => {
    /*
     * A caller who may not write must be told so whatever they send. Validating
     * first would leak which fields exist to somebody with no business knowing,
     * and would turn a 403 into a 422 for the same forbidden request.
     */
    await expect(
      settingsService.saveInvoicing({ ...repo.current().invoicing, bankBsb: 'nonsense' }, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.calls.savedInvoicing).toBeNull();
  });
});

/*
 * ── Three write surfaces were removed, and must not come back by accident ──
 *
 * Each wrote a value nothing downstream ever read: the per-event SMS/email
 * matrix (`outboundService` picks a channel from the recipient's own M8.4
 * preferences), the integration check (which recorded an outcome rather than
 * performing one), and the credential-type register (whose lead times reached
 * no reminder).
 *
 * These pin the absence rather than the removal. Re-adding one of these
 * methods "just to store the value" is exactly how a control that silently
 * does nothing gets shipped a second time.
 */
describe('the removed sections stay removed', () => {
  it('exposes no writer for notification rules, credential types or integrations', () => {
    expect(settingsService).not.toHaveProperty('saveNotifications');
    expect(settingsService).not.toHaveProperty('saveCredentialTypes');
    expect(settingsService).not.toHaveProperty('recordIntegrationCheck');
  });

  it('names none of them anywhere in what it returns', async () => {
    const settings = await settingsService.get(ADMIN);

    expect(settings).not.toHaveProperty('notifications');
    expect(settings).not.toHaveProperty('integrations');
    expect(settings).not.toHaveProperty('credentialTypes');
  });

  it('leaves the settings payload as pricing and invoicing alone', async () => {
    const settings = await settingsService.get(ADMIN);
    expect(Object.keys(settings).sort()).toEqual(['invoicing', 'pricing']);
  });

  it('still carries the assumed cost, which the financial report reads', async () => {
    /*
     * M6.8 — the margin CARD went; the value did not. Every margin figure on
     * the financial summary report is computed from this, so dropping it from
     * the contract would silently zero a report rather than fail a screen.
     */
    const settings = await settingsService.get(ADMIN);
    expect(settings.pricing.assumedCostPerJob).toBe('100.00');
  });
});

/*
 * ── What used to be the sequence guard ──────────────────────────────────────
 * `PUT /settings/general` round-tripped the whole block, so a stale tab could
 * arrive carrying a different `nextJobNumber`, and the service had to refuse it
 * in both directions — backwards re-issues consignment numbers that exist in
 * three years of TransVirtual history, forwards is a 200 that lies about what
 * was saved.
 *
 * That route is gone, so the guard is gone with it. What replaces it is the
 * stronger claim: the sequences are not on the wire contract AT ALL, so no
 * request can name one. These pin that, because re-exposing `general` "just to
 * show the numbers" is exactly how the old bug would come back.
 */
describe('the sequences are off-contract', () => {
  it('does not put a general block on the settings payload', async () => {
    const settings = await settingsService.get(ADMIN);
    expect(settings).not.toHaveProperty('general');
  });

  it('names no sequence anywhere in what it returns', async () => {
    const settings = await settingsService.get(ADMIN);
    const wire = JSON.stringify(settings);
    expect(wire).not.toContain('nextJobNumber');
    expect(wire).not.toContain('nextInvoiceNumber');
  });

  it('exposes no way to write one', () => {
    // A settings service with a `saveGeneral` again is the regression.
    expect(settingsService).not.toHaveProperty('saveGeneral');
  });

  it('still hands out numbers from the counter, which is the only writer', async () => {
    // M1.4 — reserved through the transactional counter, and it advances.
    await expect(repo.repository.takeNextNumber('nextJobNumber')).resolves.toBe(61_300);
    await expect(repo.repository.takeNextNumber('nextJobNumber')).resolves.toBe(61_301);
  });

  it('still reads the SLA, which is what the sequences never were — a live value', async () => {
    // M2.4a. No route writes it now, but every job's target date reads it.
    await expect(repo.repository.slaBusinessDays()).resolves.toBe(5);
  });
});

describe('invoicing', () => {
  function invoicing(overrides: Partial<Settings['invoicing']> = {}): Settings['invoicing'] {
    return { ...repo.current().invoicing, ...overrides };
  }

  it('refuses a BSB with no account number', async () => {
    // An invoice that prints a BSB and nothing else gets paid into nothing, and
    // the customer finds out weeks later.
    await expect(
      settingsService.saveInvoicing(invoicing({ bankAccount: '' }), ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'bankAccount' }] });
  });

  it('refuses an account number with no BSB', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ bankBsb: '' }), ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'bankBsb' }] });
  });

  it('allows both blank — payment details are optional', async () => {
    const saved = await settingsService.saveInvoicing(
      invoicing({ bankBsb: '', bankAccount: '' }),
      ADMIN,
    );
    expect(saved.bankBsb).toBe('');
  });

  it('refuses a BSB that is not six digits', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ bankBsb: '08234' }), ADMIN),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'bankBsb' }] });
  });

  it('accepts a BSB with or without the hyphen', async () => {
    await expect(
      settingsService.saveInvoicing(invoicing({ bankBsb: '082343' }), ADMIN),
    ).resolves.toMatchObject({ bankBsb: '082343' });
    await expect(
      settingsService.saveInvoicing(invoicing({ bankBsb: '082-343' }), ADMIN),
    ).resolves.toMatchObject({ bankBsb: '082-343' });
  });
});

