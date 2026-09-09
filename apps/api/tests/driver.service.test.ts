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
      return Promise.resolve();
    },
    /** M8.2 — the customer's own inbox, raised when a job completes. */
    notifyAccount: (input: { severity: string; title: string; subjectKey: string }) => {
      accountAlerts.push(input);
      return Promise.resolve();
    },
  },
}));

/** M2.6 — a futile report opens a review for the office. */
const futileReviews: Array<{ jobId: string; reason: string }> = [];

vi.mock('../src/domains/queues/queue.repository.js', () => ({
  queueRepository: {
    openFutileReview: (input: { jobId: string; reason: string }) => {
      futileReviews.push(input);
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
    // second call sees the job is already futile and returns early. Somebody
    // still has to ring the customer, but only once.
    expect(futileReviews).toHaveLength(1);
    expect(futileReviews[0]?.jobId).toBe(stop.id);
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

describe('photos (M4.5)', () => {
  it('records the photo and hands back somewhere to put the bytes', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    const result = await driverService.presignPhoto(
      stop.id,
      {
        caption: 'Pile before',
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

  it('refuses a type that would execute when served back', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await expect(
      driverService.presignPhoto(
        stop.id,
        {
          caption: '',
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

  it('posts a driver message into the job thread', async () => {
    const stop = driver.addStop({ jobNumber: 61301 });

    await driverService.sendMessage(stop.id, '  Gate is locked, no answer  ', CALLER);

    expect(driver.messages).toHaveLength(1);
    expect(driver.messages[0]?.body).toBe('Gate is locked, no answer');
    expect(driver.messages[0]?.fromDriver).toBe(true);
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
