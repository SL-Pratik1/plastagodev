import { SettingsSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, Settings } from '@plastago/shared';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Settings rules (M2.4 · W7).
 *
 * These test the things a repository cannot: who may change a platform-wide
 * setting, and what is refused outright. Both are decisions, and both are the
 * kind that get quietly reimplemented in a controller if they are not pinned
 * here.
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

/** The current values, so a test can change one field and send the rest back. */
function general(overrides: Partial<Settings['general']> = {}): Settings['general'] {
  return { ...repo.current().general, ...overrides };
}

describe('who may read settings', () => {
  it('lets office staff read them', async () => {
    // The SLA and the rate card are on screen while the office books a job, so
    // making this admin-only would hide the rules they work to.
    const settings = await settingsService.get(OFFICE);
    expect(settings.general.slaBusinessDays).toBe(5);
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
    const saved = await settingsService.saveGeneral(general({ slaBusinessDays: 7 }), ADMIN);
    expect(saved.slaBusinessDays).toBe(7);
  });

  it('allows operations', async () => {
    const saved = await settingsService.saveGeneral(general({ slaBusinessDays: 3 }), OPS);
    expect(saved.slaBusinessDays).toBe(3);
  });

  it('refuses office staff, who may read but not write', async () => {
    // The blast radius of a wrong setting is every job afterwards.
    await expect(settingsService.saveGeneral(general(), OFFICE)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.calls.savedGeneral).toBeNull();
  });

  it('refuses a customer', async () => {
    await expect(settingsService.saveGeneral(general(), CUSTOMER)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('refuses office staff on every write, not just the first', async () => {
    await expect(
      settingsService.saveNotifications(repo.current().notifications, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      settingsService.saveInvoicing(repo.current().invoicing, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      settingsService.saveCredentialTypes(repo.current().credentialTypes, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/*
 * ── The guard this domain exists for ────────────────────────────────────────
 * The sequences are displayed on the settings screen but never set from it —
 * they come from a transactional counter (M1.4). The whole `general` block
 * round-trips through the form, so a stale tab can arrive carrying a different
 * number, and the repository would quietly drop it.
 *
 * Backwards is the dangerous case: it re-issues consignment numbers that exist
 * in three years of TransVirtual history and in builders' AP systems. Forwards
 * is merely a lie — a 200 telling the office it saved something it did not.
 * Both are refused.
 */
describe('number sequences', () => {
  it('refuses to move the job sequence backwards', async () => {
    await expect(
      settingsService.saveGeneral(general({ nextJobNumber: 61_000 }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.calls.savedGeneral).toBeNull();
  });

  it('refuses to move the invoice sequence backwards', async () => {
    await expect(
      settingsService.saveGeneral(general({ nextInvoiceNumber: 104_099 }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('names the field and both numbers, so the message is actionable', async () => {
    await expect(
      settingsService.saveGeneral(general({ nextJobNumber: 61_000 }), ADMIN),
    ).rejects.toMatchObject({
      issues: [{ path: 'nextJobNumber', message: expect.stringContaining('61300') }],
    });
  });

  /*
   * Found in QA against the live API: this used to return 200 while the
   * repository silently dropped the field, so the office was told it had
   * changed a number it had not.
   */
  it('refuses a jump forward too, rather than accepting and ignoring it', async () => {
    await expect(
      settingsService.saveGeneral(general({ nextJobNumber: 62_000 }), ADMIN),
    ).rejects.toMatchObject({ status: 422 });

    expect(repo.calls.savedGeneral).toBeNull();
  });

  it('explains that the sequence advances on its own', async () => {
    await expect(
      settingsService.saveGeneral(general({ nextInvoiceNumber: 999_999 }), ADMIN),
    ).rejects.toMatchObject({
      issues: [{ path: 'nextInvoiceNumber', message: expect.stringContaining('advances') }],
    });
  });

  it('saves happily when the sequence is sent back unchanged', async () => {
    // The normal case: the form round-trips the whole block, so the numbers it
    // read are the numbers it sends.
    const saved = await settingsService.saveGeneral(general({ slaBusinessDays: 10 }), ADMIN);
    expect(saved.slaBusinessDays).toBe(10);
    expect(saved.nextJobNumber).toBe(61_300);
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

describe('credential types', () => {
  it('refuses the same type twice', async () => {
    // The last one written would silently win, making "which rule applies to an
    // HR licence" ambiguous.
    const duplicated = [...repo.current().credentialTypes, ...repo.current().credentialTypes];

    await expect(settingsService.saveCredentialTypes(duplicated, ADMIN)).rejects.toMatchObject({
      status: 422,
    });
    expect(repo.calls.savedCredentialTypes).toBeNull();
  });

  it('saves a list with no duplicates', async () => {
    const saved = await settingsService.saveCredentialTypes(
      [
        {
          type: 'drivers-licence',
          label: 'Driver’s licence',
          reminderLeadDays: 45,
          requiredForDrivers: true,
        },
        {
          type: 'white-card',
          label: 'White card',
          reminderLeadDays: 30,
          requiredForDrivers: true,
        },
      ],
      ADMIN,
    );

    expect(saved).toHaveLength(2);
  });
});

describe('integration checks (W7)', () => {
  it('records a success and stamps when it last worked', async () => {
    const updated = await settingsService.recordIntegrationCheck('xero', { ok: true }, ADMIN);

    expect(updated.state).toBe('connected');
    expect(updated.lastSuccessAt).not.toBeNull();
  });

  it('records a failure without stamping a success', async () => {
    // A failed check must not make a broken integration look like it worked a
    // moment ago.
    const updated = await settingsService.recordIntegrationCheck(
      'xero',
      { ok: false, detail: 'Token expired' },
      ADMIN,
    );

    expect(updated.state).toBe('error');
    expect(updated.lastSuccessAt).toBeNull();
    expect(updated.detail).toBe('Token expired');
  });

  it('clears a stale detail when a check passes with no message', async () => {
    await settingsService.recordIntegrationCheck('xero', { ok: false, detail: 'Boom' }, ADMIN);
    const updated = await settingsService.recordIntegrationCheck('xero', { ok: true }, ADMIN);

    // A red-dot explanation left behind on a working integration is worse than
    // none at all.
    expect(updated.detail).toBeNull();
  });

  it('404s on an integration that is not configured', async () => {
    await expect(
      settingsService.recordIntegrationCheck('twilio', { ok: true }, ADMIN),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a non-administrator', async () => {
    await expect(
      settingsService.recordIntegrationCheck('xero', { ok: true }, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.calls.integrationChecks).toEqual([]);
  });
});
