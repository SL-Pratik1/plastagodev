import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@plastago/shared';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Rate cards and additional services (M6.1, M6.2, M6.5).
 *
 * ── Why these are the sharpest tests in the settings domain ───────────────
 * Everything here protects one invariant: **a figure on an invoice the
 * customer has already seen must never move.** Rates are read at pricing time,
 * so a rate that can be edited in place silently reprices work that has
 * already been billed — and the way anybody finds out is a builder's accounts
 * payable clerk comparing two documents that disagree.
 *
 * That is Risk 1 in the project, so the rules below are asserted as refusals
 * with exact statuses rather than as "it probably validates".
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

/** Three complete zones, which every schedule write requires. */
function zones(serviceCharge = '220.00', ratePerM2 = '0.16') {
  return [
    { zone: 'sydney' as const, serviceCharge, ratePerM2 },
    { zone: 'wollongong' as const, serviceCharge, ratePerM2 },
    { zone: 'newcastle' as const, serviceCharge, ratePerM2 },
  ];
}

/* ── Creating a card (M6.1) ──────────────────────────────────────────────── */

describe('creating a rate card', () => {
  it('derives the id from the name, so nobody has to invent a slug', async () => {
    const card = await settingsService.createRateCard(
      { label: 'Metricon Homes', effectiveFrom: '2026-10-01', zones: zones() },
      ADMIN,
    );

    expect(card.id).toBe('metricon-homes');
    expect(repo.calls.createdRateCards).toEqual([
      { id: 'metricon-homes', effectiveFrom: '2026-10-01' },
    ]);
  });

  it('accepts an explicit id, for a card an external system already knows', async () => {
    const card = await settingsService.createRateCard(
      { id: 'mtc-2026', label: 'Metricon Homes', effectiveFrom: '2026-10-01', zones: zones() },
      ADMIN,
    );

    expect(card.id).toBe('mtc-2026');
  });

  it('refuses a name that cannot become an id', async () => {
    // A label of punctuation slugifies to nothing, and a card with a blank id
    // is unreachable by every route that takes one.
    await expect(
      settingsService.createRateCard(
        { label: '!!!', effectiveFrom: '2026-10-01', zones: zones() },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'label' }] });

    expect(repo.calls.createdRateCards).toEqual([]);
  });

  it('refuses an id that already exists', async () => {
    await expect(
      settingsService.createRateCard(
        { label: 'Tier 1', effectiveFrom: '2026-10-01', zones: zones() },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(repo.calls.createdRateCards).toEqual([]);
  });

  it('refuses a non-administrator, and writes nothing', async () => {
    await expect(
      settingsService.createRateCard(
        { label: 'Metricon', effectiveFrom: '2026-10-01', zones: zones() },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(repo.calls.createdRateCards).toEqual([]);
  });

  it('lets operations create one, like every other settings write', async () => {
    await expect(
      settingsService.createRateCard(
        { label: 'Metricon', effectiveFrom: '2026-10-01', zones: zones() },
        OPS,
      ),
    ).resolves.toMatchObject({ id: 'metricon' });
  });
});

/* ── Issuing a schedule (M6.2) ───────────────────────────────────────────── */

describe('issuing a rate schedule', () => {
  it('adds a dated version rather than overwriting the current one', async () => {
    const card = await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('240.00', '0.18') },
      ADMIN,
    );

    expect(repo.calls.issuedSchedules).toEqual([{ id: 'tier-1', effectiveFrom: '2026-10-01' }]);
    // Two schedules now, not one replaced.
    expect(card.schedules).toHaveLength(2);
  });

  it('closes the previous schedule the day before the new one starts', async () => {
    const card = await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('240.00', '0.18') },
      ADMIN,
    );

    // No gap and no overlap: the windows have to tile the calendar, or a job
    // on the boundary matches either two schedules or none.
    const superseded = card.schedules.find((schedule) => schedule.effectiveFrom !== '2026-10-01');
    expect(superseded?.effectiveTo).toBe('2026-09-30');
  });

  it('refuses a second schedule starting on the same day', async () => {
    // Two schedules opening on one date is ambiguous, and the unique index
    // would otherwise reject it with a duplicate-key error nobody can read.
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones() },
      ADMIN,
    );

    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-10-01', zones: zones('999.00', '9.99') },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'effectiveFrom' }] });

    expect(repo.calls.issuedSchedules).toHaveLength(1);
  });

  /*
   * The guard that matters most. A schedule starting before work that has
   * already been invoiced means the rate tables disagree with a document
   * sitting in a builder's accounts payable system.
   */
  it('refuses a schedule back-dated behind an invoiced job', async () => {
    repo.invoicedFrom('tier-1', '2026-05-10');

    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-05-01', zones: zones('999.00', '9.99') },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(repo.calls.issuedSchedules).toEqual([]);
  });

  it('refuses one starting ON the earliest invoiced date, not only before it', async () => {
    // The boundary is inclusive: a schedule starting the same day as an
    // invoiced job's ready date would reprice that very job.
    repo.invoicedFrom('tier-1', '2026-05-10');

    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-05-10', zones: zones() },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows one starting the day after the earliest invoiced job', async () => {
    repo.invoicedFrom('tier-1', '2026-05-10');

    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-05-11', zones: zones() },
        ADMIN,
      ),
    ).resolves.toBeDefined();
  });

  it('allows back-dating when nothing has been invoiced yet', async () => {
    /*
     * Correcting a rate that was keyed wrong last week, before anything was
     * billed, is legitimate and fairly common. Forbidding every back-date
     * would push that correction into a database console.
     */
    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-06-01', zones: zones() },
        ADMIN,
      ),
    ).resolves.toBeDefined();
  });

  /*
   * ⚠️ Regression. A schedule inserted BEFORE an existing one must be BOUNDED
   * by it, not left open-ended.
   *
   * The first implementation closed "whatever is currently open" and then
   * inserted the new row open-ended. For an append that is right. For a
   * back-date it left the later schedule open as well as the new one — two
   * open windows for the same card and zone, which `card_zone_open_unique`
   * rejects, so the entire write failed with a duplicate-key error the caller
   * could not read.
   */
  it('bounds a back-dated schedule by the one that follows it', async () => {
    // Append first, so there is a later schedule to be bounded by.
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('300.00', '0.20') },
      ADMIN,
    );

    const card = await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-07-01', zones: zones('250.00', '0.17') },
      ADMIN,
    );

    const backDated = card.schedules.find(
      (schedule) => schedule.effectiveFrom === '2026-07-01',
    );
    // Bounded, not open — it ends the day before October's schedule starts.
    expect(backDated?.effectiveTo).toBe('2026-09-30');

    // And exactly ONE schedule is open-ended: the newest.
    const open = card.schedules.filter((schedule) => schedule.effectiveTo === '');
    expect(open).toHaveLength(1);
    expect(open[0]?.effectiveFrom).toBe('2026-10-01');
  });

  it('keeps the windows tiling with no gap after a mid-history insert', async () => {
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('300.00', '0.20') },
      ADMIN,
    );
    const card = await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-07-01', zones: zones('250.00', '0.17') },
      ADMIN,
    );

    /*
     * Every schedule but the last must end the day before the next begins.
     * A gap prices nothing on the days inside it; an overlap makes two
     * schedules claim one job.
     */
    const ascending = [...card.schedules].sort((a, b) =>
      a.effectiveFrom.localeCompare(b.effectiveFrom),
    );

    for (const [index, schedule] of ascending.entries()) {
      const next = ascending[index + 1];
      if (!next) {
        expect(schedule.effectiveTo).toBe('');
        continue;
      }

      const dayAfterEnd = new Date(
        new Date(`${schedule.effectiveTo}T00:00:00Z`).getTime() + 86_400_000,
      )
        .toISOString()
        .slice(0, 10);

      expect(dayAfterEnd).toBe(next.effectiveFrom);
    }
  });

  it('404s on a card that does not exist', async () => {
    await expect(
      settingsService.issueSchedule(
        'no-such-card',
        { effectiveFrom: '2026-10-01', zones: zones() },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a non-administrator, and writes nothing', async () => {
    await expect(
      settingsService.issueSchedule(
        'tier-1',
        { effectiveFrom: '2026-10-01', zones: zones() },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(repo.calls.issuedSchedules).toEqual([]);
  });
});

/* ── What effective dating is FOR ────────────────────────────────────────── */

describe('pricing reads the schedule in force on the job own date', () => {
  it('prices a job on the schedule covering its date, not the newest one', async () => {
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('999.00', '9.99') },
      ADMIN,
    );

    // A September job still gets September's rate even though October's
    // schedule is now the current one. This is the whole point of M6.2.
    const september = await repo.repository.resolveRate('tier-1', 'sydney', '2026-09-15');
    expect(september?.serviceCharge).toBe('220.00');

    const october = await repo.repository.resolveRate('tier-1', 'sydney', '2026-10-15');
    expect(october?.serviceCharge).toBe('999.00');
  });

  it('switches on the boundary day itself, not the day after', async () => {
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('999.00', '9.99') },
      ADMIN,
    );

    // "Effective from 1 October" means a job ON the 1st uses the new rate.
    const boundary = await repo.repository.resolveRate('tier-1', 'sydney', '2026-10-01');
    expect(boundary?.serviceCharge).toBe('999.00');

    const dayBefore = await repo.repository.resolveRate('tier-1', 'sydney', '2026-09-30');
    expect(dayBefore?.serviceCharge).toBe('220.00');
  });

  it('reports which schedule priced it, so a figure traces to a decision', async () => {
    await settingsService.issueSchedule(
      'tier-1',
      { effectiveFrom: '2026-10-01', zones: zones('999.00', '9.99') },
      ADMIN,
    );

    const rate = await repo.repository.resolveRate('tier-1', 'sydney', '2026-10-15');
    expect(rate?.scheduleFrom).toBe('2026-10-01');
  });

  it('prices nothing for a date before every schedule', async () => {
    /*
     * Refusing beats guessing. A job dated before any agreed rate has no
     * price, and inventing one from the earliest schedule would apply figures
     * nobody had agreed at the time.
     */
    await expect(repo.repository.resolveRate('tier-1', 'sydney', '1999-01-01')).resolves.toBeNull();
  });
});

/* ── Deleting a card ─────────────────────────────────────────────────────── */

describe('deleting a rate card', () => {
  it('refuses the default card, which every other card falls back to', async () => {
    await expect(settingsService.deleteRateCard('default', ADMIN)).rejects.toMatchObject({
      status: 409,
    });

    expect(repo.calls.deletedRateCards).toEqual([]);
  });

  it('refuses a card accounts still price against', async () => {
    repo.assignAccounts('tier-1', 3);

    await expect(settingsService.deleteRateCard('tier-1', ADMIN)).rejects.toMatchObject({
      status: 409,
    });

    expect(repo.calls.deletedRateCards).toEqual([]);
  });

  it('deletes one nothing references', async () => {
    await settingsService.deleteRateCard('tier-4', ADMIN);
    expect(repo.calls.deletedRateCards).toEqual(['tier-4']);
  });

  it('404s on a card that does not exist', async () => {
    await expect(settingsService.deleteRateCard('no-such-card', ADMIN)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a non-administrator, and writes nothing', async () => {
    await expect(settingsService.deleteRateCard('tier-4', OFFICE)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.calls.deletedRateCards).toEqual([]);
  });
});

/* ── Additional services (M6.5) ──────────────────────────────────────────── */

describe('additional services', () => {
  const newCharge = {
    code: 'site-access-fee',
    label: 'Site access fee',
    kind: 'fixed' as const,
    value: '45.00',
    requiresApproval: true,
    driverRaisable: false,
  };

  it('creates one', async () => {
    const created = await settingsService.createAdditionalService(newCharge, ADMIN);
    expect(created.code).toBe('site-access-fee');
    expect(created.value).toBe('45.00');
  });

  it('never lets a request mark a charge system-generated', async () => {
    /*
     * `systemGenerated` means "derived by code that exists". Ticking it on a
     * hand-made charge would put *Created By: System* on the approvals queue
     * beside something a person invented.
     */
    const created = await settingsService.createAdditionalService(newCharge, ADMIN);
    expect(created.systemGenerated).toBe(false);
  });

  it('refuses a code that already exists', async () => {
    await expect(
      settingsService.createAdditionalService({ ...newCharge, code: 'contamination' }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a percentage above 100', async () => {
    // Almost always a typo for a fixed amount — 1000 meaning $10.00, which
    // would be a fuel levy ten times the size of the job.
    await expect(
      settingsService.createAdditionalService(
        { ...newCharge, kind: 'percentage', value: '1000' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'value' }] });
  });

  it('allows a percentage of exactly 100, and of zero', async () => {
    // Zero is how a levy is switched off without deleting it.
    await expect(
      settingsService.createAdditionalService(
        { ...newCharge, code: 'pct-100', kind: 'percentage', value: '100' },
        ADMIN,
      ),
    ).resolves.toBeDefined();

    await expect(
      settingsService.createAdditionalService(
        { ...newCharge, code: 'pct-zero', kind: 'percentage', value: '0' },
        ADMIN,
      ),
    ).resolves.toBeDefined();
  });

  it('reprices a protected charge — editing is exactly what this screen is for', async () => {
    const updated = await settingsService.updateAdditionalService(
      'futile-pickup',
      { label: 'Futile pickup', value: '135.00', requiresApproval: true, driverRaisable: true },
      ADMIN,
    );

    expect(updated.value).toBe('135.00');
  });

  it('refuses to make a system-generated charge driver-raisable', async () => {
    /*
     * It is derived from what the driver already captured — bag counts,
     * on-site minutes. Offering it as a button on their phone as well would
     * let one job be charged twice for the same thing.
     */
    await expect(
      settingsService.updateAdditionalService(
        'extra-bags',
        { label: 'Extra bags', value: '30.00', requiresApproval: true, driverRaisable: true },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'driverRaisable' }] });

    expect(repo.calls.updatedServices).toEqual([]);
  });

  it('404s when updating a charge that does not exist', async () => {
    await expect(
      settingsService.updateAdditionalService(
        'no-such-charge',
        { label: 'x', value: '1.00', requiresApproval: false, driverRaisable: false },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  /*
   * Five codes are looked up by literal name in the application. Deleting one
   * turns a driver tapping "Report contamination" into a 500, rather than
   * shortening a list on a settings screen.
   */
  it.each(['recycling-bags', 'futile-pickup', 'contamination', 'extra-bags', 'extra-load-time'])(
    'refuses to delete the protected code %s',
    async (code) => {
      await expect(settingsService.deleteAdditionalService(code, ADMIN)).rejects.toMatchObject({
        status: 409,
      });
      expect(repo.calls.deletedServices).toEqual([]);
    },
  );

  it('marks the protected codes undeletable on the way out', async () => {
    // The UI disables its delete button from this flag rather than
    // re-deriving the rule, so a row cannot offer an action that 409s.
    const settings = await settingsService.get(ADMIN);
    const futile = settings.pricing.additionalServices.find(
      (service) => service.code === 'futile-pickup',
    );

    expect(futile?.deletable).toBe(false);
  });

  it('refuses to delete a charge already raised on a job', async () => {
    await settingsService.createAdditionalService(newCharge, ADMIN);
    repo.chargeUsedOn('site-access-fee', 4);

    await expect(
      settingsService.deleteAdditionalService('site-access-fee', ADMIN),
    ).rejects.toMatchObject({ status: 409 });

    expect(repo.calls.deletedServices).toEqual([]);
  });

  it('deletes an unused, unprotected charge', async () => {
    await settingsService.createAdditionalService(newCharge, ADMIN);
    await settingsService.deleteAdditionalService('site-access-fee', ADMIN);

    expect(repo.calls.deletedServices).toEqual(['site-access-fee']);
  });

  it('refuses a non-administrator on every write', async () => {
    await expect(settingsService.createAdditionalService(newCharge, OFFICE)).rejects.toMatchObject({
      status: 403,
    });

    await expect(
      settingsService.updateAdditionalService(
        'futile-pickup',
        { label: 'x', value: '1.00', requiresApproval: false, driverRaisable: false },
        OFFICE,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      settingsService.deleteAdditionalService('futile-pickup', OFFICE),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a customer outright, on a read as well as a write', async () => {
    await expect(settingsService.get(CUSTOMER)).rejects.toMatchObject({ status: 403 });
    await expect(
      settingsService.createAdditionalService(newCharge, CUSTOMER),
    ).rejects.toMatchObject({ status: 403 });
  });
});
