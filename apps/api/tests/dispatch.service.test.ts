import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';
import {
  DRIVERS,
  createFakeDriverRepository,
  createFakeRunRepository,
} from './helpers/fake-runs.js';

/**
 * Run lifecycle rules (M3).
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The order of operations IS the design: the allocator shapes the day before
 * staffing it (Matt, 44:50), so create / fill / assign are three steps and a
 * run with no driver is a valid thing. These tests pin the transitions that
 * protect a driver already holding a run — changing its contents underneath him
 * is how a stop gets missed.
 */

let runs: ReturnType<typeof createFakeRunRepository>;
let drivers: ReturnType<typeof createFakeDriverRepository>;
let settings: ReturnType<typeof createFakeSettingsRepository>;

// GETTERS, not values: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/dispatch/run.repository.js', () => ({
  get runRepository() {
    return runs.repository;
  },
}));

vi.mock('../src/domains/dispatch/driver.repository.js', () => ({
  get driverRepository() {
    return drivers.repository;
  },
}));

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return settings.repository;
  },
}));

vi.mock('../src/domains/jobs/job.repository.js', () => ({
  jobRepository: {
    runSheetStops: () => Promise.resolve([]),
    mapPins: () => Promise.resolve([]),
  },
}));

const { dispatchService } = await import('../src/domains/dispatch/dispatch.service.js');

const DATE = '2026-03-02';
const WAYNE = DRIVERS[0]!.id;
const TOM = DRIVERS[1]!.id;

beforeEach(() => {
  runs = createFakeRunRepository();
  drivers = createFakeDriverRepository();
  settings = createFakeSettingsRepository();
});

/** A planning run with `count` stops on it. */
async function runWithStops(count: number) {
  const jobIds = runs.seedJobs(...Array.from({ length: count }, (_, i) => `job${String(i)}`.padStart(24, '0')));
  const run = await dispatchService.createRun({
    name: 'Newcastle run 1',
    date: DATE,
    driverId: null,
    jobIds,
  });
  return { run, jobIds };
}

describe('creating a run', () => {
  it('takes a run number from the sequence', async () => {
    const run = await dispatchService.createRun({
      name: 'Newcastle run 1',
      date: DATE,
      driverId: null,
      jobIds: [],
    });

    expect(run.runNumber).toBe(1);
    expect(run.name).toBe('Newcastle run 1');
  });

  /*
   * Matt, 44:50 — "rather than an allocation board per se, it'd be a run sheet
   * creator". An empty, unstaffed run is most of what the board holds at 7am.
   */
  it('allows a run with no driver and no stops', async () => {
    const run = await dispatchService.createRun({
      name: 'Sydney afternoon',
      date: DATE,
      driverId: null,
      jobIds: [],
    });

    expect(run.status).toBe('planning');
    expect(run.driverId).toBeNull();
    expect(run.stops).toEqual([]);
  });

  it('fills a run with the jobs it was given, in order', async () => {
    const { run, jobIds } = await runWithStops(3);

    expect(run.stops.map((stop) => stop.id)).toEqual(jobIds);
    expect(run.stops.map((stop) => stop.sequence)).toEqual([1, 2, 3]);
  });

  it('is already staffed when created with a driver', async () => {
    const run = await dispatchService.createRun({
      name: 'South Coast',
      date: DATE,
      driverId: WAYNE,
      jobIds: [],
    });

    expect(run.status).toBe('assigned');
    expect(run.driverName).toBe('Wayne Corrigan');
    expect(run.sequenceForDay).toBe(1);
  });

  it('refuses a driver it cannot find', async () => {
    await expect(
      dispatchService.createRun({
        name: 'Ghost run',
        date: DATE,
        driverId: 'f'.repeat(24),
        jobIds: [],
      }),
    ).rejects.toMatchObject({ status: 422, issues: [{ path: 'driverId' }] });
  });

  it('trims the name it was given', async () => {
    const run = await dispatchService.createRun({
      name: '  Kellyville cluster  ',
      date: DATE,
      driverId: null,
      jobIds: [],
    });

    expect(run.name).toBe('Kellyville cluster');
  });
});

describe('filling a run', () => {
  it('adds a job to the end', async () => {
    const { run } = await runWithStops(2);
    const [extra] = runs.seedJobs('extra'.padStart(24, '0'));

    await dispatchService.addJobToRun(run.id, extra!);

    expect(runs.run(run.id)?.stops).toHaveLength(3);
  });

  /*
   * A job on two runs is a stop that gets collected twice or not at all. The
   * allocator is told to take it off the other run rather than having it
   * silently moved.
   */
  it('refuses a job that is already on another run', async () => {
    const { run, jobIds } = await runWithStops(2);
    const other = await dispatchService.createRun({
      name: 'Other',
      date: DATE,
      driverId: null,
      jobIds: [],
    });

    await expect(dispatchService.addJobToRun(other.id, jobIds[0]!)).rejects.toMatchObject({
      status: 409,
    });
    expect(runs.run(run.id)?.stops).toContain(jobIds[0]);
  });

  it('removes a stop and closes the gap it left', async () => {
    const { run, jobIds } = await runWithStops(3);

    await dispatchService.removeJobFromRun(run.id, jobIds[1]!);

    // The sheet must never read 1, 2, 4.
    const last = runs.calls.resequences.at(-1);
    expect(last?.jobIds).toEqual([jobIds[0], jobIds[2]]);
  });

  it('returns a removed stop to the unallocated pool', async () => {
    const { run, jobIds } = await runWithStops(2);
    await dispatchService.removeJobFromRun(run.id, jobIds[0]!);

    expect(runs.isFree(jobIds[0]!)).toBe(true);
  });

  it('404s removing a job that is not on the run', async () => {
    const { run } = await runWithStops(1);

    await expect(
      dispatchService.removeJobFromRun(run.id, 'z'.repeat(24)),
    ).rejects.toMatchObject({ status: 404 });
  });
});

/*
 * ── The guard this domain exists for ────────────────────────────────────────
 * `planning` is the only state in which stops may be added or removed. Once a
 * driver has the run on his phone, changing its contents underneath him is how
 * a stop gets missed.
 */
describe('a run that is already with a driver', () => {
  async function assignedRun() {
    const { run, jobIds } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);
    return { run, jobIds };
  }

  it('refuses a new stop', async () => {
    const { run } = await assignedRun();
    const [extra] = runs.seedJobs('extra'.padStart(24, '0'));

    await expect(dispatchService.addJobToRun(run.id, extra!)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a stop removal', async () => {
    const { run, jobIds } = await assignedRun();

    await expect(dispatchService.removeJobFromRun(run.id, jobIds[0]!)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a reorder', async () => {
    const { run, jobIds } = await assignedRun();

    await expect(dispatchService.reorderRun(run.id, [...jobIds].reverse())).rejects.toMatchObject({
      status: 409,
    });
  });

  it('tells the allocator to unassign first', async () => {
    const { run } = await assignedRun();
    const [extra] = runs.seedJobs('extra'.padStart(24, '0'));

    await expect(dispatchService.addJobToRun(run.id, extra!)).rejects.toMatchObject({
      message: expect.stringContaining('Unassign'),
    });
  });

  it('accepts changes again once unassigned', async () => {
    const { run } = await assignedRun();
    await dispatchService.unassignRun(run.id);

    const [extra] = runs.seedJobs('extra'.padStart(24, '0'));
    await expect(dispatchService.addJobToRun(run.id, extra!)).resolves.toBeUndefined();
  });

  it('refuses stop changes once the run has started', async () => {
    const { run } = await runWithStops(2);
    runs.setStatus(run.id, 'in-progress');

    const [extra] = runs.seedJobs('extra'.padStart(24, '0'));
    await expect(dispatchService.addJobToRun(run.id, extra!)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('ordering the stops', () => {
  it('accepts a genuine reorder', async () => {
    const { run, jobIds } = await runWithStops(3);
    const reversed = [...jobIds].reverse();

    await dispatchService.reorderRun(run.id, reversed);

    expect(runs.run(run.id)?.stops).toEqual(reversed);
  });

  /*
   * A partial list would silently drop the stops it omitted, and a stop that
   * vanishes off a run sheet is a collection that does not happen.
   */
  it('refuses a list that drops a stop', async () => {
    const { run, jobIds } = await runWithStops(3);

    await expect(dispatchService.reorderRun(run.id, jobIds.slice(0, 2))).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuses a list of the right length that names one job twice', async () => {
    // Passes a length check, loses a stop. Membership is what is checked.
    const { run, jobIds } = await runWithStops(3);

    await expect(
      dispatchService.reorderRun(run.id, [jobIds[0]!, jobIds[0]!, jobIds[1]!]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a list containing a job from another run', async () => {
    const { run, jobIds } = await runWithStops(2);

    await expect(
      dispatchService.reorderRun(run.id, [jobIds[0]!, 'z'.repeat(24)]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('clears the optimised stamp when a human reorders', async () => {
    const { run, jobIds } = await runWithStops(2);
    await dispatchService.optimiseRun(run.id);
    await dispatchService.reorderRun(run.id, [...jobIds].reverse());

    // That stamp is what tells the UI there is something to lose next time
    // somebody asks to optimise.
    expect(runs.run(run.id)?.optimisedAt).toBeNull();
  });

  it('stamps the run when it is optimised', async () => {
    const { run } = await runWithStops(3);
    const optimised = await dispatchService.optimiseRun(run.id);

    expect(optimised.optimisedAt).not.toBeNull();
    expect(runs.calls.resequences.at(-1)?.optimised).toBe(true);
  });

  it('groups stops by suburb when optimising', async () => {
    // Honest grouping rather than a route nobody computed — the Google
    // integration (I11) is not wired yet.
    const { run } = await runWithStops(4);
    const optimised = await dispatchService.optimiseRun(run.id);

    const suburbs = optimised.stops.map((stop) => stop.suburb);
    expect(suburbs).toEqual([...suburbs].sort((a, b) => a.localeCompare(b)));
  });
});

describe('staffing a run', () => {
  it('assigns a driver and marks the run assigned', async () => {
    const { run } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);

    expect(runs.run(run.id)?.status).toBe('assigned');
    expect(runs.run(run.id)?.driverName).toBe('Wayne Corrigan');
  });

  /*
   * Matt, 40:03 — a driver normally takes two runs in a day: morning South
   * Coast, tip off, afternoon Sydney. Two is a normal day, not an error.
   */
  it('numbers a driver’s second run of the day as 2', async () => {
    const first = await runWithStops(1);
    await dispatchService.assignRun(first.run.id, WAYNE);

    const second = await runWithStops(1);
    await dispatchService.assignRun(second.run.id, WAYNE);

    expect(runs.calls.assigns.map((a) => a.sequenceForDay)).toEqual([1, 2]);
  });

  it('numbers a different driver’s run independently', async () => {
    const first = await runWithStops(1);
    await dispatchService.assignRun(first.run.id, WAYNE);

    const second = await runWithStops(1);
    await dispatchService.assignRun(second.run.id, TOM);

    expect(runs.calls.assigns.at(-1)?.sequenceForDay).toBe(1);
  });

  it('refuses to assign an empty run', async () => {
    // An empty run on a driver's phone is a wasted trip to the depot.
    const run = await dispatchService.createRun({
      name: 'Empty',
      date: DATE,
      driverId: null,
      jobIds: [],
    });

    await expect(dispatchService.assignRun(run.id, WAYNE)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to assign a run that already has a driver', async () => {
    const { run } = await runWithStops(1);
    await dispatchService.assignRun(run.id, WAYNE);

    await expect(dispatchService.assignRun(run.id, TOM)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a driver it cannot find', async () => {
    const { run } = await runWithStops(1);

    await expect(dispatchService.assignRun(run.id, 'f'.repeat(24))).rejects.toMatchObject({
      status: 422,
    });
  });

  it('returns an unassigned run to planning', async () => {
    const { run } = await runWithStops(1);
    await dispatchService.assignRun(run.id, WAYNE);
    await dispatchService.unassignRun(run.id);

    expect(runs.run(run.id)?.status).toBe('planning');
    expect(runs.run(run.id)?.driverId).toBeNull();
    expect(runs.run(run.id)?.sequenceForDay).toBeNull();
  });

  it('refuses to unassign a run nobody is on', async () => {
    const { run } = await runWithStops(1);

    await expect(dispatchService.unassignRun(run.id)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to unassign a run that has started', async () => {
    const { run } = await runWithStops(1);
    await dispatchService.assignRun(run.id, WAYNE);
    runs.setStatus(run.id, 'in-progress');

    await expect(dispatchService.unassignRun(run.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('deleting a run', () => {
  it('releases its stops rather than deleting them', async () => {
    // The work still has to happen — that is the only sane reading of "delete
    // this run".
    const { run, jobIds } = await runWithStops(2);
    await dispatchService.deleteRun(run.id);

    expect(jobIds.every((id) => runs.isFree(id))).toBe(true);
  });

  it('refuses once the run has started', async () => {
    const { run } = await runWithStops(1);
    runs.setStatus(run.id, 'in-progress');

    // Deleting the record does not recall the truck; it just removes the only
    // thing that says where the driver is meant to be.
    await expect(dispatchService.deleteRun(run.id)).rejects.toMatchObject({ status: 409 });
  });

  /*
   * ⚠️ Regression. This used to be permitted, which left the two rules
   * disagreeing: a stop could not be added to an assigned run, but the whole
   * run could be deleted — and the driver's phone lost the day with nothing to
   * say why. Deleting every stop at once is the same act as changing one, so it
   * takes the same discipline.
   */
  it('refuses while a driver is holding it, and says to unassign first', async () => {
    const { run } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);

    await expect(dispatchService.deleteRun(run.id)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Unassign it'),
    });
  });

  it('allows the delete once the driver has been taken off', async () => {
    const { run, jobIds } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);
    await dispatchService.unassignRun(run.id);

    await dispatchService.deleteRun(run.id);

    expect(jobIds.every((id) => runs.isFree(id))).toBe(true);
  });

  it('404s a run that does not exist', async () => {
    await expect(dispatchService.deleteRun('f'.repeat(24))).rejects.toMatchObject({ status: 404 });
  });
});

describe('the board', () => {
  it('shows a driver as on-run when they are carrying one', async () => {
    const { run } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);

    const board = await dispatchService.board(DATE);
    const wayne = board.drivers.find((d) => d.driverId === WAYNE);

    expect(wayne?.status).toBe('on-run');
    expect(wayne?.assignedCount).toBe(2);
    expect(wayne?.runs).toHaveLength(1);
  });

  it('shows an idle driver as available with nothing on', async () => {
    const board = await dispatchService.board(DATE);
    const tom = board.drivers.find((d) => d.driverId === TOM);

    expect(tom?.status).toBe('available');
    expect(tom?.assignedCount).toBe(0);
  });

  it('lists every stop against the run it belongs to', async () => {
    const { run } = await runWithStops(2);
    await dispatchService.assignRun(run.id, WAYNE);

    const board = await dispatchService.board(DATE);
    const wayne = board.drivers.find((d) => d.driverId === WAYNE);

    expect(wayne?.jobs.every((job) => job.runId === run.id)).toBe(true);
  });

  it('includes unstaffed runs, because that is most of the board at 7am', async () => {
    await runWithStops(2);
    const board = await dispatchService.board(DATE);

    expect(board.runs).toHaveLength(1);
    expect(board.runs[0]?.driverId).toBeNull();
  });
});
