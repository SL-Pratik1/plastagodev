import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOutbound,
  makeFakeNotificationRepository,
  recordingProviders,
  sentMessages,
} from './helpers/fake-outbound.js';
import { createFakeDriverRepository } from './helpers/fake-driver.js';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * The driver app (M4).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The OFFLINE contract. A driver's phone queues actions and replays them when
 * signal returns — sometimes hours later, sometimes twice. So the questions
 * these tests answer are: does a replay do nothing the second time, is a stale
 * action refused, and can a duplicate report bill the customer twice.
 *
 * The second theme is that the driver must never be blocked by our plumbing: no
 * GPS fix, no signal and no crane weight are all normal, and none of them may
 * stop somebody finishing a job.
 */

const DRIVER = 'd'.repeat(24);
const OTHER_DRIVER = 'e'.repeat(24);

let driver: ReturnType<typeof createFakeDriverRepository>;
let settings: ReturnType<typeof createFakeSettingsRepository>;

// GETTERS, not values: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/driver/driver.repository.js', () => ({
  get driverRepository() {
    return driver.repository;
  },
  loadJobDetail: (jobId: string) => driver.loadJobDetail(jobId),
  addDriverMessage: (input: { jobId: string; body: string; author: string; at: Date }) =>
    driver.addDriverMessage(input),
}));

/** The two URGENT alerts the driver app raises. See `notifyOffice`. */
const urgentAlerts: Array<{ severity: string; title: string; subjectKey: string }> = [];

/** What the customer's portal inbox was told. Asserted where it matters. */
const accountAlerts: Array<{ severity: string; title: string; subjectKey: string }> = [];

vi.mock('../src/domains/notifications/notification.service.js', () => ({
  notificationService: {
    notifyOffice: (input: { severity: string; title: string; subjectKey: string }) => {
      urgentAlerts.push(input);
      return Promise.resolve([]);
    },
    /** M8.2 — the customer's own inbox, raised when a job completes. */
    notifyJobAudience: (input: { severity: string; title: string; subjectKey: string }) => {
      accountAlerts.push(input);
      return Promise.resolve([]);
    },
  },
}));

/** M2.6 — a futile report opens a review for the office. */
const futileReviews: Array<{ jobId: string; reason: string }> = [];

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    /*
     * Idempotent on the job, exactly as the real `$setOnInsert` upsert is. A
     * replay now reaches this call again — that is how a half-saved report gets
     * its review — so a fake that recorded every call would count a second
     * review the database would never have written.
     */
    openFutileReview: (input: { jobId: string; reason: string }) => {
      if (!futileReviews.some((review) => review.jobId === input.jobId)) futileReviews.push(input);
      return Promise.resolve();
    },
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return settings.repository;
  },
}));

/* The storage provider is swapped for one that records rather than writes. */
const uploads: Array<{ key: string; contentType: string }> = [];
const removed: string[] = [];

vi.mock('../src/integrations/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/storage.js')>();
  return {
    ...actual,
    getStorage: () => ({
      name: 'test',
      presignUpload: (input: { key: string; contentType: string }) => {
        uploads.push(input);
        return Promise.resolve({
          key: input.key,
          uploadUrl: `https://example.test/${input.key}`,
          headers: {},
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        });
      },
      presignDownload: (key: string) => Promise.resolve(`https://example.test/${key}`),
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error('not used')),
      remove: (key: string) => {
        removed.push(key);
        return Promise.resolve();
      },
      exists: () => Promise.resolve(true),
    }),
  };
});

/*
 * M8.1 / M8.2 — booking a job, moving it and completing it now message the site
 * contact, and every send is logged. Faked like every other repository: the
 * real one would buffer a write against a MongoDB that is not there.
 */
vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: makeFakeNotificationRepository(),
}));

/*
 * The notice needs the SITE CONTACT, which the driver's own read model does not
 * carry — the phone is told about a stop, not about who to text. So the notice
 * module reads the job, and that read is faked here.
 */
vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: {
    findById: () =>
      Promise.resolve({
        id: '000000000000000000000015',
        jobNumber: 61_301,
        accountId: 'acc0000000000000000000a1',
        accountName: 'Clarendon Homes',
        siteName: 'Lot 77 Britannia Road',
        targetDate: '2026-09-10',
        siteContactEmail: null,
        siteContactMobile: '0466778899',
        expectedAreaM2: 42,
        recoveredWeightKg: 1180,
        bagCount: 0,
        photos: [{ id: 'p1' }, { id: 'p2' }],
      }),
  },
}));

const { driverService } = await import('../src/domains/driver/driver.service.js');
const { setMessagingProvidersForTests } = await import('../src/integrations/messaging.js');

const CALLER = { userId: DRIVER, name: 'Troy Holm', vehicleRego: 'BQ12AB' };

/** Every driver action carries these two. See `DriverActionEnvelopeSchema`. */
function envelope(at = '2026-09-10T08:00:00.000Z') {
  return { occurredAt: at, position: { latitude: -33.7, longitude: 150.9, accuracyMetres: 12 } };
}

beforeEach(() => {
  clearOutbound();
  setMessagingProvidersForTests(recordingProviders());
  driver = createFakeDriverRepository(DRIVER);
  settings = createFakeSettingsRepository();
  uploads.length = 0;
  removed.length = 0;
  futileReviews.length = 0;
  urgentAlerts.length = 0;
});

describe('seeing only your own work', () => {
  it('404s a job on another driver’s run', async () => {
    const stop = driver.addStop({ jobNumber: 61301, driverId: OTHER_DRIVER });

    // 404, not 403: a 403 confirms the job exists, and the phone has no
    // business learning that.
    await expect(driverService.job(stop.id, CALLER)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to move a job that is not yours', async () => {
    const stop = driver.addStop({ jobNumber: 61301, driverId: OTHER_DRIVER });

    await expect(
      driverService.updateStatus(stop.id, { ...envelope(), transition: 'arrived' }, CALLER),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('leaves another driver’s run sheet out of yours', async () => {
    driver.addStop({ jobNumber: 61301, driverId: OTHER_DRIVER });
    driver.addStop({ jobNumber: 61302 });

    const sheet = await driverService.runSheet('2026-09-10', CALLER);

    expect(sheet.stops).toHaveLength(1);
    expect(sheet.stops[0]?.jobNumber).toBe(61302);
  });

  /*
   * The run sheet is where the phone learns which truck it is on — the sign-in
   * token says who the driver is, not what they are driving. Everything that
   * records something ABOUT the vehicle reads it from here.
   */
  it('names the truck the driver is paired with', async () => {
    driver.addStop({ jobNumber: 61301 });
    driver.assignVehicle({ rego: 'CD34EF', label: 'Truck 2 — Hino crane' });

    const sheet = await driverService.runSheet('2026-09-10', { ...CALLER, vehicleRego: null });

    expect(sheet.vehicleRego).toBe('CD34EF');
    expect(sheet.vehicleLabel).toBe('Truck 2 — Hino crane');
  });

  it('leaves the truck null when the driver is paired with none', async () => {
    driver.addStop({ jobNumber: 61301 });
    driver.assignVehicle(null);

    const sheet = await driverService.runSheet('2026-09-10', { ...CALLER, vehicleRego: null });

    // Null rather than a blank string: the driver screens read this as "you
    // cannot start a pre-start yet" and say so, instead of filing one against
    // nothing.
    expect(sheet.vehicleRego).toBeNull();
    expect(sheet.vehicleLabel).toBeNull();
  });
});

describe('status, replayed from the outbox', () => {
  /*
   * ⚠️ The central offline rule. The phone replays a queued action on
   * reconnect; the earlier attempt already landed. Answering 409 would make the
   * driver's app show a failure for something that worked.
   */
  it('treats a replayed transition as success, not a conflict', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const action = { ...envelope(), transition: 'arrived' as const };

    await driverService.updateStatus(stop.id, action, CALLER);
    await expect(driverService.updateStatus(stop.id, action, CALLER)).resolves.toBeUndefined();

    expect(driver.stop(stop.id)?.status).toBe('arrived');
    // And it does not write the event twice, or the timeline would show two
    // arrivals at the same site.
    expect(driver.events.filter((event) => event.status === 'arrived')).toHaveLength(1);
  });

  /*
   * Different from a replay: this is an OLDER action arriving after a newer
   * one, which is what happens when a phone syncs out of order. Applying it
   * would rewrite the timeline.
   */
  it('refuses a stale action that would walk the job backwards', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'completed');

    await expect(
      driverService.updateStatus(stop.id, { ...envelope(), transition: 'in-transit' }, CALLER),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records the driver’s own timestamp, not the server’s', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const at = '2026-09-10T06:15:00.000Z';

    await driverService.updateStatus(stop.id, { ...envelope(at), transition: 'arrived' }, CALLER);

    // A run synced at 5pm must not collapse into one timestamp — the on-site
    // durations, and the charge derived from them, would become fiction.
    expect(driver.events.at(-1)?.at.toISOString()).toBe(at);
  });

  it('carries the position when there is one', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.updateStatus(stop.id, { ...envelope(), transition: 'arrived' }, CALLER);

    expect(driver.events.at(-1)?.latitude).toBe(-33.7);
  });

  /*
   * A driver in a basement car park with no fix still has to be able to work.
   * Position is evidence when available, never a precondition.
   */
  it('accepts an action with no position at all', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.updateStatus(
      stop.id,
      { occurredAt: '2026-09-10T08:00:00.000Z', position: null, transition: 'arrived' },
      CALLER,
    );

    expect(driver.stop(stop.id)?.status).toBe('arrived');
    expect(driver.events.at(-1)?.latitude).toBeNull();
  });

  it('refuses to collect a job the office cancelled', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'cancelled');

    await expect(
      driverService.updateStatus(stop.id, { ...envelope(), transition: 'arrived' }, CALLER),
    ).rejects.toMatchObject({ status: 409 });
  });
});

/**
 * M8.2 · F24 — what the site is told when the job is closed.
 *
 * The site contact on this fixture is mobile-only, which is the common case:
 * §9 makes site supervisors SMS-first because they have "no email to check" on
 * a building site. So the completion summary has to reach them by text.
 */
describe('the completion message (M8.2)', () => {
  it('texts the site contact, with the figures', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.complete(
      stop.id,
      { ...envelope('2026-09-10T08:45:00.000Z'), note: '' },
      CALLER,
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.channel).toBe('sms');
    expect(sentMessages[0]?.body).toContain('Lot 77 Britannia Road');
    expect(sentMessages[0]?.body).toContain('42 m²');
  });

  /** And the customer's own inbox, for whoever does have a login. */
  it('raises it in the customer portal too', async () => {
    const stop = driver.addStop({ jobNumber: 61302 });

    await driverService.complete(
      stop.id,
      { ...envelope('2026-09-10T08:45:00.000Z'), note: '' },
      CALLER,
    );

    expect(accountAlerts.at(-1)?.title).toContain('Pickup complete');
  });
});

describe('completing a job', () => {
  it('derives the on-site duration from arrival to completion', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.updateStatus(
      stop.id,
      { ...envelope('2026-09-10T08:00:00.000Z'), transition: 'arrived' },
      CALLER,
    );
    await driverService.complete(
      stop.id,
      { ...envelope('2026-09-10T08:45:00.000Z'), note: 'All clear' },
      CALLER,
    );

    // 45 minutes. This is the basis of the extra-load-time charge, so it has to
    // come from one clock at both ends.
    expect(driver.stop(stop.id)?.status).toBe('completed');
    expect(driver.stop(stop.id)?.completedAt?.toISOString()).toBe('2026-09-10T08:45:00.000Z');
  });

  it('is a no-op when replayed', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const action = { ...envelope(), note: 'Done' };

    await driverService.complete(stop.id, action, CALLER);
    await expect(driverService.complete(stop.id, action, CALLER)).resolves.toBeUndefined();

    expect(driver.events.filter((event) => event.status === 'completed')).toHaveLength(1);
  });

  /*
   * M4.8b — checked at COMPLETION, never at arrival. Matt was explicit
   * (1:07:26) that the assessment must not gate access to the job; the driver
   * decides when to fill it in.
   */
  it('blocks completion where the site requires a risk assessment', async () => {
    const stop = driver.addStop({ jobNumber: 61301, riskAssessmentRequired: true });

    await expect(
      driverService.complete(stop.id, { ...envelope(), note: '' }, CALLER),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows completion once the assessment is filed', async () => {
    const stop = driver.addStop({ jobNumber: 61301, riskAssessmentRequired: true });

    await driverService.submitRiskAssessment(
      {
        ...envelope(),
        jobId: stop.id,
        hazardKeys: ['uneven-ground'],
        controlKeys: ['ppe'],
        note: '',
        safeToProceed: true,
        swmsVersion: '2026.1',
        builderPortalCode: null,
      },
      CALLER,
    );

    await expect(
      driverService.complete(stop.id, { ...envelope(), note: '' }, CALLER),
    ).resolves.toBeUndefined();
  });

  it('does not block a site that does not require one', async () => {
    const stop = driver.addStop({ jobNumber: 61301, riskAssessmentRequired: false });

    await expect(
      driverService.complete(stop.id, { ...envelope(), note: '' }, CALLER),
    ).resolves.toBeUndefined();
  });
});

describe('weights (M4.3)', () => {
  it('marks a crane-weighed load as ACTUAL', async () => {
    const stop = driver.addStop({ jobNumber: 61301, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 4, loadType: 'bagged', craneScaleKg: 820 },
      CALLER,
    );

    // Matt, 56:11 — weighed is actual, worked out is estimated. The distinction
    // is printed on a diversion certificate.
    expect(driver.stop(stop.id)?.recoveredWeightBasis).toBe('actual');
    expect(driver.stop(stop.id)?.recoveredWeightKg).toBe(820);
  });

  it('leaves a hand load with no weight and no basis', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 0, loadType: 'hand-load', craneScaleKg: null },
      CALLER,
    );

    // Null, not zero: the weighbridge supplies this one later, and a zero would
    // enter the reconciliation as "we collected nothing".
    expect(driver.stop(stop.id)?.recoveredWeightKg).toBeNull();
    expect(driver.stop(stop.id)?.recoveredWeightBasis).toBeNull();
  });

  /*
   * ⚠️ The deadlock these two guard against.
   *
   * `weightsRecordedAt` used to be derived as
   * `recoveredWeightBasis !== null && completedAt !== null`. Completion is
   * blocked until weights are recorded, so that expression could not become
   * true until the job was already complete — and no job could be finished on
   * the phone at all. It is a stored fact now, stamped when the driver saves.
   */
  it('stamps the weights as recorded when the driver saves, not when the job completes', async () => {
    const stop = driver.addStop({ jobNumber: 61301, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 4, loadType: 'bagged', craneScaleKg: 820 },
      CALLER,
    );

    expect(driver.stop(stop.id)?.weightsRecordedAt).not.toBeNull();
    // Still on site — the stamp must not wait for the job to finish.
    expect(driver.stop(stop.id)?.completedAt).toBeNull();
  });

  it('stamps a hand load as recorded too, though it carries no kilograms', async () => {
    const stop = driver.addStop({ jobNumber: 61302 });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 0, loadType: 'hand-load', craneScaleKg: null },
      CALLER,
    );

    // "Recorded" means the driver answered the question. Gating it on a weight
    // basis would leave every hand load permanently uncompletable.
    expect(driver.stop(stop.id)?.weightsRecordedAt).not.toBeNull();
    expect(driver.stop(stop.id)?.recoveredWeightBasis).toBeNull();
  });

  it('keeps the load type the driver chose, over the office booking guess', async () => {
    // Booked with no crane, so the office's guess is "hand load".
    const stop = driver.addStop({ jobNumber: 61303, craneAvailable: false });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 3, loadType: 'bagged', craneScaleKg: 600 },
      CALLER,
    );

    // The driver found bags. The run sheet used to keep saying "hand load"
    // because the stored answer was never persisted and never read.
    expect(driver.stop(stop.id)?.loadType).toBe('bagged');
  });

  it('refuses a crane weight on a hand load', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await expect(
      driverService.captureWeights(
        stop.id,
        { ...envelope(), bagCount: 0, loadType: 'hand-load', craneScaleKg: 500 },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  /* M2.3 — an m²-only account must never have a weight recorded against it. */
  it('refuses a weight for an account that records square metres only', async () => {
    const stop = driver.addStop({ jobNumber: 61301, capturesWeight: false, craneAvailable: true });

    await expect(
      driverService.captureWeights(
        stop.id,
        { ...envelope(), bagCount: 2, loadType: 'bagged', craneScaleKg: 400 },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

/*
 * Matt, 06:34: *"bag one, my way 320, bag 2, my way 290, bag 3, you know what I
 * mean? The each bag[']s weight needs to be recorded."*
 *
 * The total stays the figure that gets priced and printed — these tests pin
 * down that it is DERIVED from the readings rather than typed a second time.
 */
describe('a reading per bag (M4.3, Matt 06:34)', () => {
  it('stores every reading and derives the total from them', async () => {
    const stop = driver.addStop({ jobNumber: 61301, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      {
        ...envelope(),
        bagCount: 4,
        loadType: 'bagged',
        bagWeights: [320, 290, 310, 320],
        craneScaleKg: null,
      },
      CALLER,
    );

    expect(driver.stop(stop.id)?.bagWeights).toEqual([320, 290, 310, 320]);
    // 320 + 290 + 310 + 320. The client sent no total at all.
    expect(driver.stop(stop.id)?.recoveredWeightKg).toBe(1240);
    expect(driver.stop(stop.id)?.recoveredWeightBasis).toBe('actual');
  });

  /*
   * A typed total is a second source of truth for one quantity, and it is the
   * copy that reaches the invoice. Where both arrive, the bags win.
   */
  it('ignores a client-sent total that disagrees with the bags', async () => {
    const stop = driver.addStop({ jobNumber: 61302, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      {
        ...envelope(),
        bagCount: 2,
        loadType: 'bagged',
        bagWeights: [400, 350],
        craneScaleKg: 9999,
      },
      CALLER,
    );

    expect(driver.stop(stop.id)?.recoveredWeightKg).toBe(750);
  });

  /*
   * Half-kilo readings are normal on a crane scale. Summing them as floats
   * yields 1239.9999999999998, and that is the number a builder would read.
   */
  it('rounds the derived total to the kilogram', async () => {
    const stop = driver.addStop({ jobNumber: 61303, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      {
        ...envelope(),
        bagCount: 3,
        loadType: 'bagged',
        bagWeights: [310.1, 310.1, 310.1],
        craneScaleKg: null,
      },
      CALLER,
    );

    expect(driver.stop(stop.id)?.recoveredWeightKg).toBe(930);
  });

  it('refuses a breakdown that does not account for every bag', async () => {
    const stop = driver.addStop({ jobNumber: 61304, craneAvailable: true });

    await expect(
      driverService.captureWeights(
        stop.id,
        {
          ...envelope(),
          bagCount: 4,
          loadType: 'bagged',
          bagWeights: [320, 290],
          craneScaleKg: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses per-bag readings on a hand load', async () => {
    const stop = driver.addStop({ jobNumber: 61305 });

    await expect(
      driverService.captureWeights(
        stop.id,
        {
          ...envelope(),
          bagCount: 0,
          loadType: 'hand-load',
          bagWeights: [120],
          craneScaleKg: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses per-bag readings for an account that records square metres only', async () => {
    const stop = driver.addStop({ jobNumber: 61306, capturesWeight: false, craneAvailable: true });

    await expect(
      driverService.captureWeights(
        stop.id,
        {
          ...envelope(),
          bagCount: 1,
          loadType: 'bagged',
          bagWeights: [400],
          craneScaleKg: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a breakdown heavier than the truck can carry', async () => {
    const stop = driver.addStop({ jobNumber: 61307, craneAvailable: true });

    await expect(
      driverService.captureWeights(
        stop.id,
        {
          ...envelope(),
          bagCount: 2,
          loadType: 'bagged',
          bagWeights: [15000, 15000],
          craneScaleKg: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  /*
   * ⚠️ The regression that matters on deploy day. A phone that queued a pickup
   * before per-bag capture shipped replays a payload with a total and NO
   * `bagWeights` key. Rejecting it would discard a collection that happened.
   */
  it('still accepts a legacy payload that carries only a total', async () => {
    const stop = driver.addStop({ jobNumber: 61308, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 4, loadType: 'bagged', craneScaleKg: 820 },
      CALLER,
    );

    expect(driver.stop(stop.id)?.recoveredWeightKg).toBe(820);
    expect(driver.stop(stop.id)?.recoveredWeightBasis).toBe('actual');
    // No breakdown exists for it, and none is invented.
    expect(driver.stop(stop.id)?.bagWeights).toEqual([]);
  });

  /* The office has to be able to see WHICH bag was heavy, not just the total. */
  it('writes the individual readings onto the job timeline', async () => {
    const stop = driver.addStop({ jobNumber: 61309, craneAvailable: true });

    await driverService.captureWeights(
      stop.id,
      {
        ...envelope(),
        bagCount: 2,
        loadType: 'bagged',
        bagWeights: [320, 290],
        craneScaleKg: null,
      },
      CALLER,
    );

    const entry = driver.events.find((event) => event.label === 'Weights captured');
    expect(entry?.detail).toBe('2 bags, 610 kg on the crane scale (320, 290 kg)');
  });
});

/*
 * Matt, 07:37: *"if the purchase order's only got two bags on it and there's
 * three bags on a site… that extra bag needs to be on a separate invoice like
 * for an overage."* And 09:02, on who does the work: *"the driver doesn't
 * really know, he's just going to tell us what's on site. The system has to
 * sort of understand that this job's got an extra bag on it."*
 *
 * So every test here drives the ordinary weights screen and then asks what the
 * OFFICE ended up with. None of them tells the driver anything about a PO.
 */
describe('bags beyond the purchase order (M6.5, Matt 07:37)', () => {
  /** The weights payload, with the driver's own count of what was on site. */
  const collected = (bags: number) => ({
    ...envelope(),
    bagCount: bags,
    loadType: 'bagged' as const,
    bagWeights: Array.from({ length: bags }, () => 300),
    craneScaleKg: null,
  });

  const extraBagCharge = () => driver.charges.find((charge) => charge.code === 'extra-bags');

  /*
   * ⚠️ The regression this whole feature rests on. The driver's count used to
   * be written over `bagCount`, which is the allowance copied off the order and
   * the quantity the base invoice is priced on. Once it was gone, nothing could
   * tell that a two-bag order had come back with four.
   */
  it('keeps the order allowance intact when the driver saves a different count', async () => {
    const stop = driver.addStop({ jobNumber: 61401, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);

    expect(driver.stop(stop.id)?.bagCount).toBe(2);
    expect(driver.stop(stop.id)?.collectedBagCount).toBe(4);
  });

  it('charges only the excess, and only once', async () => {
    const stop = driver.addStop({ jobNumber: 61402, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);

    const charge = extraBagCharge();
    // Two bags over, at the same $30 an ordered bag costs.
    expect(charge?.quantity).toBe(2);
    expect(charge?.unitRate).toBe('30.00');
    expect(charge?.amount).toBe('60.00');
  });

  /*
   * The charge has to reach the office as a DRIVER charge, because that is the
   * flag invoicing splits on: driver charges go onto their own invoice with no
   * PO number and wait for the builder to issue a second order (M7.3). Marked
   * pending because Matt, 08:28, wants it approved before it is billed.
   */
  it('queues the excess for office approval rather than billing it', async () => {
    const stop = driver.addStop({ jobNumber: 61403, bagCount: 1, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(2), CALLER);

    expect(extraBagCharge()?.approvalState).toBe('pending');
  });

  it('raises nothing when the driver collects exactly the allowance', async () => {
    const stop = driver.addStop({ jobNumber: 61404, bagCount: 3, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(3), CALLER);

    expect(extraBagCharge()).toBeUndefined();
  });

  it('raises nothing when the driver collects fewer than the allowance', async () => {
    const stop = driver.addStop({ jobNumber: 61405, bagCount: 4, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(2), CALLER);

    expect(extraBagCharge()).toBeUndefined();
  });

  /*
   * A job with no order behind it — a contractor, or a phone booking — states
   * no allowance. Every bag the driver finds is then work nobody has authorised
   * yet, and letting it through unbilled is how the money quietly goes missing.
   */
  it('charges every bag on a job whose order allowed for none', async () => {
    const stop = driver.addStop({ jobNumber: 61406, bagCount: 0, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(3), CALLER);

    expect(extraBagCharge()?.quantity).toBe(3);
  });

  /*
   * ⚠️ Replay. The phone queues weights offline and can send them twice hours
   * apart. A second charge here bills the builder for four extra bags when two
   * were collected.
   */
  it('does not raise a second charge when the phone replays the same weights', async () => {
    const stop = driver.addStop({ jobNumber: 61407, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);
    await driverService.captureWeights(stop.id, collected(4), CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'extra-bags')).toHaveLength(1);
    expect(extraBagCharge()?.quantity).toBe(2);
  });

  /* An overage is a quantity, so a corrected count has to move the charge. */
  it('follows a revised bag count upwards', async () => {
    const stop = driver.addStop({ jobNumber: 61408, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);
    await driverService.captureWeights(stop.id, collected(6), CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'extra-bags')).toHaveLength(1);
    expect(extraBagCharge()?.quantity).toBe(4);
    expect(extraBagCharge()?.amount).toBe('120.00');
  });

  it('withdraws the charge when a miscount is corrected back within the allowance', async () => {
    const stop = driver.addStop({ jobNumber: 61409, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(5), CALLER);
    expect(extraBagCharge()?.quantity).toBe(3);

    await driverService.captureWeights(stop.id, collected(2), CALLER);
    expect(extraBagCharge()).toBeUndefined();
  });

  /*
   * Once the office has approved an amount, a person has acted on that number.
   * Rewriting it underneath them would change an approved charge with no trace,
   * so the count moves and the charge is flagged instead.
   */
  it('leaves an already-approved charge alone and flags the change', async () => {
    const stop = driver.addStop({ jobNumber: 61410, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);
    const approved = extraBagCharge();
    if (approved) approved.approvalState = 'approved';

    await driverService.captureWeights(stop.id, collected(7), CALLER);

    expect(extraBagCharge()?.quantity).toBe(2);
    expect(extraBagCharge()?.approvalState).toBe('approved');
    expect(
      driver.events.some(
        (event) => event.label === 'Extra bags' && /already been decided/i.test(event.detail ?? ''),
      ),
    ).toBe(true);
  });

  /* Matt, 09:02 — the office needs to see it. Nothing goes to the phone. */
  it('records the overage on the job timeline for the office', async () => {
    const stop = driver.addStop({ jobNumber: 61411, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);

    const entry = driver.events.find((event) => event.label === 'Extra bags');
    expect(entry?.detail).toContain('4 bags collected against an order for 2');
    expect(entry?.detail).toContain('needs its own purchase order');
  });

  /*
   * ⚠️ With no extra-bag price set, the overage used to be a log line and a
   * timeline note — money silently not charged unless somebody opened the job.
   */
  it('tells the office when no extra-bag price is set', async () => {
    await settings.repository.deleteAdditionalService('extra-bags');
    const stop = driver.addStop({ jobNumber: 61413, bagCount: 2, craneAvailable: true });

    await driverService.captureWeights(stop.id, collected(4), CALLER);

    expect(extraBagCharge()).toBeUndefined();
    expect(urgentAlerts).toEqual([
      expect.objectContaining({
        title: 'Extra bags not charged — #61413',
        subjectKey: `extra-bags-unpriced:${stop.id}`,
        href: `/admin/jobs/${stop.id}?tab=charges`,
      }),
    ]);
    // Money: the office roles only, never the allocator.
    expect((urgentAlerts[0] as { audience?: string }).audience).toBeUndefined();
  });

  /* A hand load has no bags at all, so there is nothing to exceed. */
  it('ignores hand loads entirely', async () => {
    const stop = driver.addStop({ jobNumber: 61412, bagCount: 2 });

    await driverService.captureWeights(
      stop.id,
      { ...envelope(), bagCount: 0, loadType: 'hand-load', bagWeights: [], craneScaleKg: null },
      CALLER,
    );

    expect(extraBagCharge()).toBeUndefined();
  });
});

describe('charges raised from the phone', () => {
  /*
   * ⚠️ The idempotency that costs money. A replayed contamination report would
   * otherwise raise a second $90 charge, the office would approve both, and the
   * customer is billed twice for one pile of timber.
   */
  it('raises exactly one contamination charge however many times it is replayed', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const report = {
      ...envelope(),
      type: 'timber' as const,
      extent: 'moderate' as const,
      note: 'Through the middle of the stack',
      photoIds: ['p1', 'p2'],
    };

    await driverService.markContaminated(stop.id, report, CALLER);
    await driverService.markContaminated(stop.id, report, CALLER);
    await driverService.markContaminated(stop.id, report, CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'contamination')).toHaveLength(1);
  });

  it('raises exactly one futile charge however many times it is replayed', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const report = {
      ...envelope(),
      reason: 'site-not-ready' as const,
      note: 'Board still on the walls',
      photoIds: ['p1'],
    };

    await driverService.markFutile(stop.id, report, CALLER);
    await driverService.markFutile(stop.id, report, CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'futile-pickup')).toHaveLength(1);
    expect(driver.stop(stop.id)?.status).toBe('futile');

    // M2.6 — and ONE review is opened for the office, not one per replay: the
    // second call finds the job futile and everything already recorded, so it
    // adds nothing. Somebody still has to ring the customer, but only once.
    expect(futileReviews).toHaveLength(1);
    expect(futileReviews[0]?.jobId).toBe(stop.id);
    expect(driver.events.filter((event) => event.status === 'futile')).toHaveLength(1);
  });

  /*
   * ⚠️ A futile pickup told nobody: the office heard only through a sweep that
   * never ran, and the customer first learned of it on the invoice.
   */
  it('tells the office and the allocator straight away', async () => {
    const stop = driver.addStop({ jobNumber: 61301, siteName: 'Lot 77 Britannia Road' });

    await driverService.markFutile(
      stop.id,
      { ...envelope(), reason: 'site-not-ready', note: 'Board still on the walls', photoIds: ['p1'] },
      CALLER,
    );

    expect(urgentAlerts).toEqual([
      expect.objectContaining({
        audience: 'dispatch',
        severity: 'action',
        subjectKey: `futile:${stop.id}`,
        href: '/admin/queues/futile',
        // The allocator cannot open the queues, so theirs goes to the job.
        allocatorHref: `/admin/jobs/${stop.id}`,
      }),
    ]);
    expect(urgentAlerts[0]?.title).toContain('#61301');
  });

  it('tells the customer the same day — once, however often the phone replays it', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const report = {
      ...envelope(),
      reason: 'access-blocked' as const,
      note: '',
      photoIds: ['p1'],
    };

    await driverService.markFutile(stop.id, report, CALLER);
    await driverService.markFutile(stop.id, report, CALLER);

    // The job read by the notice carries a mobile and no email — so a text.
    const texts = sentMessages.filter((message) => message.channel === 'sms');
    expect(texts).toHaveLength(1);
    expect(texts[0]?.to).toBe('0466778899');
    expect(texts[0]?.body).toContain('could not collect');
    expect(texts[0]?.body).toContain('Truck access blocked');
    // No fee in it — whether it stands is the office's decision.
    expect(texts[0]?.body).not.toMatch(/\$\d/);
    expect(accountAlerts.at(-1)?.title).toContain('Pickup not collected');
  });

  /*
   * ⚠️ REGRESSION. The status change's result was ignored, so a report queued
   * offline that reached a job the office had cancelled in the meantime still
   * raised the $120 fee and opened a review — against a job nobody was to
   * collect.
   */
  it('refuses to mark a cancelled job futile, and charges nothing', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'in-transit' });
    driver.setStatus(stop.id, 'cancelled');

    await expect(
      driverService.markFutile(
        stop.id,
        { ...envelope(), reason: 'site-closed', note: '', photoIds: ['p1'] },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(driver.charges).toHaveLength(0);
    expect(futileReviews).toHaveLength(0);
    expect(driver.events).toHaveLength(0);
    expect(driver.stop(stop.id)?.status).toBe('cancelled');
  });

  it('refuses a job the office has already closed', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'admin-complete');

    await expect(
      driverService.markFutile(
        stop.id,
        { ...envelope(), reason: 'site-closed', note: '', photoIds: ['p1'] },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(driver.charges).toHaveLength(0);
    expect(futileReviews).toHaveLength(0);
  });

  /*
   * ⚠️ REGRESSION — the half-saved report. The status moved first and a replay
   * used to return straight away on "already futile", so a first attempt that
   * failed on the charge could never be finished: no fee, no review, and the
   * office never heard the truck was turned away.
   */
  it('finishes a futile report that was half-saved the first time', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'arrived' });
    const report = {
      ...envelope(),
      reason: 'nobody-on-site' as const,
      note: 'Gate padlocked',
      photoIds: ['p1'],
    };

    driver.failNextCharge();
    await expect(driverService.markFutile(stop.id, report, CALLER)).rejects.toThrow();

    // The status moved; nothing after it did.
    expect(driver.stop(stop.id)?.status).toBe('futile');
    expect(driver.charges).toHaveLength(0);
    expect(futileReviews).toHaveLength(0);

    // The phone's retry completes it — once.
    await driverService.markFutile(stop.id, report, CALLER);
    await driverService.markFutile(stop.id, report, CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'futile-pickup')).toHaveLength(1);
    expect(futileReviews).toHaveLength(1);
    expect(driver.events.filter((event) => event.status === 'futile')).toHaveLength(1);
  });

  it('records how many photos back the charge', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.markFutile(
      stop.id,
      { ...envelope(), reason: 'access-blocked', note: '', photoIds: ['p1', 'p2', 'p3'] },
      CALLER,
    );

    // The office approves this by looking at the picture; a charge with no
    // photo is one the customer successfully disputes.
    expect(driver.charges[0]?.photoCount).toBe(3);
  });

  it('refuses to mark a completed job futile', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'completed');

    await expect(
      driverService.markFutile(
        stop.id,
        { ...envelope(), reason: 'access-blocked', note: '', photoIds: ['p1'] },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

/*
 * M4.7 — ONE contamination report per job.
 *
 * Nothing told the phone a report had been made, so the button stayed on the
 * job and a driver filed the same load eleven times. The job now says it was
 * reported, and a further report changes nothing.
 */
describe('contamination — one report per job (M4.7)', () => {
  function report(overrides: Partial<{ type: 'timber' | 'metal'; note: string }> = {}) {
    return {
      ...envelope(),
      type: overrides.type ?? ('timber' as const),
      extent: 'heavy' as const,
      note: overrides.note ?? 'Offcuts through the second bag',
      photoIds: ['p1'],
    };
  }

  it('tells the phone the job has been reported', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'arrived' });

    expect((await driverService.job(stop.id, CALLER)).contamination).toBeNull();

    await driverService.markContaminated(stop.id, report(), CALLER);

    expect((await driverService.job(stop.id, CALLER)).contamination).toEqual({
      reportedAt: '2026-09-10T08:00:00.000Z',
      type: 'timber',
      extent: 'heavy',
    });
  });

  it('records a second report as nothing at all', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'arrived' });

    await expect(driverService.markContaminated(stop.id, report(), CALLER)).resolves.toEqual({
      chargeRaised: true,
    });
    await expect(
      driverService.markContaminated(stop.id, report({ type: 'metal' }), CALLER),
    ).resolves.toEqual({ chargeRaised: false });

    expect(driver.events.filter((event) => event.label === 'Contamination reported')).toHaveLength(
      1,
    );
    expect(driver.charges.filter((charge) => charge.code === 'contamination')).toHaveLength(1);
    // The first report stands; the second did not overwrite what was reported.
    expect(driver.contaminationReport(stop.id)?.type).toBe('timber');
  });

  /*
   * A job reported before the report record existed carries only the charge.
   * Reading that as the report is what stops it offering the form again the
   * day this ships.
   */
  it('treats a report made before the record existed as made', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'arrived' });
    driver.addCharge({
      jobId: stop.id,
      code: 'contamination',
      amount: '90.00',
      photoCount: 1,
      note: 'metal · light — Screws in the pile',
      source: 'driver',
      raisedAt: new Date('2026-09-09T02:00:00.000Z'),
    });

    expect((await driverService.job(stop.id, CALLER)).contamination).toEqual({
      reportedAt: '2026-09-09T02:00:00.000Z',
      type: 'metal',
      extent: 'light',
    });

    await driverService.markContaminated(stop.id, report(), CALLER);

    expect(driver.events).toHaveLength(0);
    expect(driver.charges).toHaveLength(1);
  });

  /*
   * ⚠️ The report is stored first. A failure after it must be finished by the
   * phone's retry — not taken as "already reported" and dropped, which would
   * leave a recorded contamination that nobody is ever charged for.
   */
  it('finishes a report that was half-saved the first time', async () => {
    const stop = driver.addStop({ jobNumber: 61301, status: 'arrived' });

    driver.failNextCharge();
    await expect(driverService.markContaminated(stop.id, report(), CALLER)).rejects.toThrow();

    expect(driver.contaminationReport(stop.id)).toBeDefined();
    expect(driver.charges).toHaveLength(0);

    await expect(driverService.markContaminated(stop.id, report(), CALLER)).resolves.toEqual({
      chargeRaised: true,
    });
    await driverService.markContaminated(stop.id, report(), CALLER);

    expect(driver.charges.filter((charge) => charge.code === 'contamination')).toHaveLength(1);
    expect(driver.charges[0]?.note).toBe('timber · heavy — Offcuts through the second bag');
    expect(driver.events.filter((event) => event.label === 'Contamination reported')).toHaveLength(
      1,
    );
  });

  it('refuses a report on a job the office cancelled', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'cancelled');

    await expect(driverService.markContaminated(stop.id, report(), CALLER)).rejects.toMatchObject({
      status: 409,
    });
    expect(driver.contaminationReport(stop.id)).toBeUndefined();
    expect(driver.charges).toHaveLength(0);
  });

  it('refuses a report on a job marked as could not collect', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    driver.setStatus(stop.id, 'futile');

    await expect(driverService.markContaminated(stop.id, report(), CALLER)).rejects.toMatchObject({
      status: 409,
    });
    expect(driver.charges).toHaveLength(0);
  });
});

describe('photos (M4.5)', () => {
  it('records the photo and hands back somewhere to put the bytes', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    const result = await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Pile before',
        slot: 'pile-before',
        contentType: 'image/jpeg',
        contentLength: 2_400_000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    expect(result.photoId).toBeTruthy();
    expect(result.upload.uploadUrl).toContain(result.upload.key);
    // The record exists before the bytes do — an orphaned record is a visible
    // gap, an unrecorded object is invisible and unfindable.
    expect(uploads).toHaveLength(1);
  });

  /*
   * ⚠️ REGRESSION. `slot` was accepted by the schema, carried across the wire
   * and then dropped on the floor here: the service never passed it to the
   * repository, so every photo was filed under the model's null default.
   *
   * Nothing failed. The driver took "front of site", the app said "4 still
   * needed", they took it again, and again — each one landing as an anonymous
   * extra. The checklist that exists to prove the five-shot protocol was
   * followed could never be satisfied, on any job, by anyone.
   */
  it('files the photo under the shot the driver actually took', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Front of site',
        slot: 'front-of-site',
        contentType: 'image/jpeg',
        contentLength: 1000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    const job = await driverService.job(stop.id, CALLER);
    expect(job.photos).toHaveLength(1);
    expect(job.photos[0]?.slot).toBe('front-of-site');
  });

  it('keeps a free-form extra unslotted', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Damaged fence',
        slot: null,
        contentType: 'image/jpeg',
        contentLength: 1000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    const job = await driverService.job(stop.id, CALLER);
    expect(job.photos[0]?.slot).toBeNull();
  });

  /*
   * ⚠️ REGRESSION. `uploaded` was derived from `storageKey !== null`, but the
   * key is assigned while the upload URL is being SIGNED — before a byte
   * exists. So every photo reported itself as safely uploaded the instant it
   * was registered, including ones whose PUT never happened.
   */
  it('does not call a photo uploaded until the phone confirms it', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    const created = await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Pile after',
        slot: 'pile-after',
        contentType: 'image/jpeg',
        contentLength: 1000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    const before = await driverService.job(stop.id, CALLER);
    expect(before.photos[0]?.uploaded).toBe(false);
    // Nothing to look at yet, and a URL to a missing object renders as a broken
    // image — which reads as "lost", not "still sending".
    expect(before.photos[0]?.url).toBeNull();

    await driverService.confirmPhotoUpload(stop.id, created.photoId, CALLER);

    const after = await driverService.job(stop.id, CALLER);
    expect(after.photos[0]?.uploaded).toBe(true);
    expect(after.photos[0]?.url).toBeTruthy();
  });

  it('takes a repeated confirmation without complaint', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const created = await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Site closed',
        slot: 'site-closed',
        contentType: 'image/jpeg',
        contentLength: 1000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    // The outbox replays on a flaky connection; a retry is the normal case.
    await driverService.confirmPhotoUpload(stop.id, created.photoId, CALLER);
    await expect(
      driverService.confirmPhotoUpload(stop.id, created.photoId, CALLER),
    ).resolves.toBeUndefined();
  });

  it('refuses a type that would execute when served back', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await expect(
      driverService.presignPhoto(
        stop.id,
        {
          caption: '',
          slot: null,
          contentType: 'image/svg+xml',
          contentLength: 1000,
          takenAt: '2026-09-10T08:05:00.000Z',
          position: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses an upload larger than the cap', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await expect(
      driverService.presignPhoto(
        stop.id,
        {
          caption: '',
          slot: null,
          contentType: 'image/jpeg',
          contentLength: 40 * 1024 * 1024,
          takenAt: '2026-09-10T08:05:00.000Z',
          position: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('deletes the object as well as the record', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });
    const created = await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Oops',
        slot: null,
        contentType: 'image/jpeg',
        contentLength: 1000,
        takenAt: '2026-09-10T08:05:00.000Z',
        position: null,
      },
      CALLER,
    );

    await driverService.removePhoto(stop.id, created.photoId, CALLER);

    // Orphaned bytes in a bucket cost money for nothing.
    expect(removed).toHaveLength(1);
    expect(driver.photoCount()).toBe(0);
  });
});

describe('pre-start (M4.8a)', () => {
  it('turns each failed item into a defect somebody has to close', async () => {
    driver.addStop({ jobNumber: 61301 });

    await driverService.submitPreStart(
      {
        ...envelope(),
        date: '2026-09-10',
        vehicleRego: 'BQ12AB',
        odometerKm: 184_320,
        items: [
          { key: 'tyres', state: 'pass', note: '' },
          { key: 'brakes', state: 'fail', note: 'Pedal feels soft' },
          { key: 'lights', state: 'fail', note: 'Near-side indicator out' },
        ],
        declaration: true,
      },
      CALLER,
    );

    // Chain of Responsibility makes this an operator obligation — a failed item
    // is not a warning to dismiss.
    expect(driver.defects).toHaveLength(2);
    expect(driver.defects.map((defect) => defect.preStartItemKey)).toEqual(['brakes', 'lights']);
  });

  it('records the denominator, not just the failures', async () => {
    driver.addStop({ jobNumber: 61301 });

    await driverService.submitPreStart(
      {
        ...envelope(),
        date: '2026-09-10',
        vehicleRego: 'BQ12AB',
        odometerKm: 184_320,
        items: [
          { key: 'tyres', state: 'pass', note: '' },
          { key: 'brakes', state: 'pass', note: '' },
        ],
        declaration: true,
      },
      CALLER,
    );

    expect(driver.preStarts).toHaveLength(1);
    expect(driver.defects).toHaveLength(0);
  });

  it('refuses when the driver has no runs that day', async () => {
    await expect(
      driverService.submitPreStart(
        {
          ...envelope(),
          date: '2026-09-11',
          vehicleRego: 'BQ12AB',
          odometerKm: 1,
          items: [],
          declaration: true,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  /*
   * ── The rego comes from the pairing, never from the phone ───────────────
   * The run sheet is cached on the handset, so `input.vehicleRego` is whatever
   * it held when it was last fetched — blank for a driver who had no truck then.
   * A blank plate does not fail loudly: the record saves, and then never appears
   * on any vehicle screen, because the office finds defects by matching it.
   */
  it('files the pre-start against the truck the driver is paired with, not the one sent', async () => {
    driver.addStop({ jobNumber: 61301 });
    driver.assignVehicle({ rego: 'CD34EF', label: 'Truck 2 — Hino crane' });

    await driverService.submitPreStart(
      {
        ...envelope(),
        date: '2026-09-10',
        // What a phone with a stale run sheet sends.
        vehicleRego: '',
        odometerKm: 184_320,
        items: [{ key: 'brakes', state: 'fail', note: 'Pedal feels soft' }],
        declaration: true,
      },
      { ...CALLER, vehicleRego: null },
    );

    expect(driver.defects).toHaveLength(1);
    expect(driver.defects[0]?.rego).toBe('CD34EF');
  });

  it('refuses when no truck is paired with the driver', async () => {
    driver.addStop({ jobNumber: 61301 });
    driver.assignVehicle(null);

    // A pre-start is a record of which VEHICLE was checked. One filed against no
    // vehicle satisfies nothing, so refusing beats saving it somewhere nobody
    // will ever look.
    await expect(
      driverService.submitPreStart(
        {
          ...envelope(),
          date: '2026-09-10',
          vehicleRego: '',
          odometerKm: 184_320,
          items: [{ key: 'brakes', state: 'fail', note: 'Pedal feels soft' }],
          declaration: true,
        },
        { ...CALLER, vehicleRego: null },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(driver.preStarts).toHaveLength(0);
    expect(driver.defects).toHaveLength(0);
  });
});

describe('tip-off (M4.4)', () => {
  it('previews without writing anything', async () => {
    const a = driver.addStop({ jobNumber: 61301, expectedAreaM2: 1000 });
    driver.addStop({ jobNumber: 61302, expectedAreaM2: 500 });

    const preview = await driverService.previewTipOff('run1', 3000, CALLER);

    expect(preview.lines.find((line) => line.jobId === a.id)?.imputedKg).toBe(2000);
    expect(driver.tipOffs).toHaveLength(0);
    expect(driver.imputed).toHaveLength(0);
  });

  it('commits the docket and writes the imputed weights', async () => {
    driver.addStop({ jobNumber: 61301, expectedAreaM2: 1000 });
    driver.addStop({ jobNumber: 61302, expectedAreaM2: 500 });

    await driverService.recordTipOff(
      {
        ...envelope(),
        runId: 'run1',
        date: '2026-09-10',
        totalKg: 3000,
        docketReference: 'WB-8821',
        docketPhotoId: null,
      },
      CALLER,
    );

    expect(driver.tipOffs).toHaveLength(1);
    expect(driver.imputed).toHaveLength(2);
    expect(driver.imputed.map((line) => line.imputedKg).sort((a, b) => a - b)).toEqual([1000, 2000]);
  });

  /*
   * ⚠️ These figures go onto diversion certificates and EPA records. Committing
   * a remainder that does not add up would corrupt one, and unpicking it later
   * means reissuing a document with a customer's name on it.
   */
  it('refuses a docket the crane weights exceed', async () => {
    driver.addStop({
      jobNumber: 61301,
      loadType: 'bagged',
      craneAvailable: true,
      recoveredWeightKg: 900,
      recoveredWeightBasis: 'actual',
    });
    driver.addStop({ jobNumber: 61302, expectedAreaM2: 500 });

    await expect(
      driverService.recordTipOff(
        {
          ...envelope(),
          runId: 'run1',
          date: '2026-09-10',
          totalKg: 500,
          docketReference: 'WB-8822',
          docketPhotoId: null,
        },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(driver.imputed).toHaveLength(0);
  });

  it('is idempotent — a replayed docket does not double up', async () => {
    driver.addStop({ jobNumber: 61301, expectedAreaM2: 1000 });
    const entry = {
      ...envelope(),
      runId: 'run1',
      date: '2026-09-10',
      totalKg: 2000,
      docketReference: 'WB-8823',
      docketPhotoId: null,
    };

    await driverService.recordTipOff(entry, CALLER);
    await driverService.recordTipOff(entry, CALLER);

    expect(driver.tipOffs).toHaveLength(1);
  });

  it('404s a run that is not on your sheet', async () => {
    await expect(driverService.previewTipOff('nobody-run', 1000, CALLER)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('defects and messages', () => {
  /*
   * ⚠️ REGRESSION. Defect photos were declared as references to `jobphotos`,
   * which a defect can never have — it is about the truck, and is often
   * reported before the day's first job. So the repository filtered `photoIds`
   * down to valid ObjectIds and the app, having no upload path at all, sent
   * invented UUIDs. Every id failed the filter. A driver who photographed a
   * cracked windscreen three times filed a report with no photos, and was told
   * each time that the photo had been saved.
   */
  it('keeps the photo keys attached to a defect', async () => {
    const keys = [
      `plastago/defects/${DRIVER}/photos/6f1c6f2e-1b7a-4f19-9a0e-6d6a4b2f0c11.jpg`,
      `plastago/defects/${DRIVER}/photos/8a2d7e3f-2c8b-4a20-8b1f-7e7b5c3a1d22.jpg`,
    ];

    await driverService.reportDefect(
      {
        ...envelope(),
        vehicleRego: 'BQ12AB',
        severity: 'needs-attention',
        summary: 'Cracked windscreen',
        detail: '',
        photoIds: keys,
      },
      CALLER,
    );

    expect(driver.defects[0]?.photoIds).toEqual(keys);
  });

  it('hands back somewhere to put a defect photo', async () => {
    const result = await driverService.presignDefectPhoto(
      { contentType: 'image/jpeg', contentLength: 1_200_000 },
      CALLER,
    );

    // The key IS the id the report carries — there is no record to point at,
    // because the photo is taken before the defect exists.
    expect(result.photoId).toBe(result.upload.key);
    // Under the defect scope, not a job's.
    expect(result.photoId).toContain('defects/');
    expect(result.photoId).not.toContain('jobs/');
  });

  it('refuses a defect photo type that would execute when served back', async () => {
    await expect(
      driverService.presignDefectPhoto(
        { contentType: 'image/svg+xml', contentLength: 1000 },
        CALLER,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('records a defect reported directly', async () => {
    await driverService.reportDefect(
      {
        ...envelope(),
        vehicleRego: 'BQ12AB',
        severity: 'unroadworthy',
        summary: 'Brake line weeping',
        detail: 'Visible fluid at the rear axle',
        photoIds: [],
      },
      CALLER,
    );

    expect(driver.defects).toHaveLength(1);
    expect(driver.defects[0]?.severity).toBe('unroadworthy');

    // ⚠️ An unroadworthy truck cannot wait for the nightly sweep — the
    // allocator may be about to put it on tomorrow's run.
    expect(urgentAlerts).toHaveLength(1);
    expect(urgentAlerts[0]?.severity).toBe('urgent');
    expect(urgentAlerts[0]?.title).toContain('UNROADWORTHY');
  });

  /*
   * The report screen sends the literal string `Unknown` when it has no run
   * sheet to read a plate off. That files the defect against a truck that does
   * not exist, where no vehicle screen can ever surface it.
   */
  it('files a defect against the paired truck, ignoring what the phone sent', async () => {
    driver.assignVehicle({ rego: 'EF56GH', label: 'Truck 3 — Isuzu hooklift' });

    await driverService.reportDefect(
      {
        ...envelope(),
        vehicleRego: 'Unknown',
        severity: 'unroadworthy',
        summary: 'Brake line weeping',
        detail: 'Visible fluid at the rear axle',
        photoIds: [],
      },
      { ...CALLER, vehicleRego: null },
    );

    expect(driver.defects[0]?.rego).toBe('EF56GH');
    // The alert names the real truck too — an allocator cannot act on "Unknown".
    expect(urgentAlerts[0]?.title).toContain('EF56GH');
  });

  it('refuses a defect when no truck is paired with the driver', async () => {
    driver.assignVehicle(null);

    await expect(
      driverService.reportDefect(
        {
          ...envelope(),
          vehicleRego: 'Unknown',
          severity: 'monitor',
          summary: 'Wiper juddering',
          detail: '',
          photoIds: [],
        },
        { ...CALLER, vehicleRego: null },
      ),
    ).rejects.toMatchObject({ status: 409 });

    expect(driver.defects).toHaveLength(0);
  });

  it('posts a driver message into the job thread', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.sendMessage(stop.id, '  Gate is locked, no answer  ', CALLER);

    expect(driver.messages).toHaveLength(1);
    expect(driver.messages[0]?.body).toBe('Gate is locked, no answer');
    expect(driver.messages[0]?.fromDriver).toBe(true);
  });

  /*
   * ⚠️ A driver's message used to sit on the job until somebody opened it —
   * while the driver waited at a locked gate.
   */
  it('tells the office and the allocator when a driver writes', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.sendMessage(stop.id, 'Gate is locked, no answer', CALLER);

    expect(urgentAlerts).toEqual([
      expect.objectContaining({
        audience: 'dispatch',
        category: 'message',
        severity: 'action',
        body: 'Troy Holm: Gate is locked, no answer',
        href: `/admin/jobs/${stop.id}?tab=comments&thread=driver`,
        subjectKey: `driver-message:${driver.messages[0]?.id ?? ''}`,
      }),
    ]);
  });

  it('refuses a message on someone else’s job', async () => {
    const stop = driver.addStop({ jobNumber: 61301, driverId: OTHER_DRIVER });

    await expect(driverService.sendMessage(stop.id, 'hello', CALLER)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the two urgent alerts (M8.7)', () => {
  /*
   * ⚠️ A driver has walked off a site. Somebody must ring the builder NOW —
   * waiting for the nightly sweep means finding out tomorrow that a pickup did
   * not happen and nobody knew why.
   */
  it('raises an urgent alert when a driver judges a site unsafe', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.submitRiskAssessment(
      {
        ...envelope(),
        jobId: stop.id,
        hazardKeys: ['overhead-powerlines'],
        controlKeys: ['stopped-work'],
        note: 'Live wires over the stack',
        safeToProceed: false,
        swmsVersion: '2026.1',
        builderPortalCode: null,
      },
      CALLER,
    );

    expect(urgentAlerts).toHaveLength(1);
    expect(urgentAlerts[0]?.severity).toBe('urgent');
    expect(urgentAlerts[0]?.subjectKey).toBe(`site-unsafe:${stop.id}`);
  });

  /* A safe assessment is the normal case and must interrupt nobody. */
  it('raises nothing when the site is safe', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.submitRiskAssessment(
      {
        ...envelope(),
        jobId: stop.id,
        hazardKeys: ['no-hazards'],
        controlKeys: ['ppe'],
        note: '',
        safeToProceed: true,
        swmsVersion: '2026.1',
        builderPortalCode: null,
      },
      CALLER,
    );

    expect(urgentAlerts).toHaveLength(0);
  });

  /*
   * Restraint is the point. A centre where everything is urgent trains people
   * to ignore it — a monitor-level defect waits for the sweep.
   */
  it('does not interrupt anybody about a minor defect', async () => {
    await driverService.reportDefect(
      {
        ...envelope(),
        vehicleRego: 'BQ12AB',
        severity: 'monitor',
        summary: 'Wiper blade streaking',
        detail: '',
        photoIds: [],
      },
      CALLER,
    );

    expect(driver.defects).toHaveLength(1);
    expect(urgentAlerts).toHaveLength(0);
  });
});
