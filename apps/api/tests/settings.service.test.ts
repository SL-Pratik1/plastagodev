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
    const saved = await settingsService.saveNotifications(
      { ...repo.current().notifications, reminderLeadDays: 3 },
      OPS,
    );
    expect(saved.reminderLeadDays).toBe(3);
  });

  it('refuses office staff, who may read but not write', async () => {
    // The blast radius of a wrong setting is every job afterwards.
    await expect(
      settingsService.saveNotifications(repo.current().notifications, OFFICE),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.calls.savedNotifications).toBeNull();
  });

  it('refuses a customer', async () => {
    await expect(
      settingsService.saveNotifications(repo.current().notifications, CUSTOMER),
    ).rejects.toMatchObject({ status: 403 });
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
