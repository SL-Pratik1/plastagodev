import { describe, expect, it } from 'vitest';
import {
  reconcileTipOff,
  type ReconciliationStop,
} from '../src/domains/driver/tipoff.js';

/**
 * Tip-off reconciliation (M4.4).
 *
 * These figures are printed on diversion certificates (M9.5 · F52) and filed as
 * EPA RRO14 records, so this is the second most consequential arithmetic in the
 * system after money. The rule comes straight from Matt at 56:11 and the first
 * test below is his own worked example.
 */

const RUN = { runId: 'r'.repeat(24), runName: 'South Coast morning', date: '2026-09-10' };

function stop(overrides: Partial<ReconciliationStop> & { jobNumber: number }): ReconciliationStop {
  return {
    jobId: String(overrides.jobNumber).padStart(24, '0'),
    siteName: `Lot ${String(overrides.jobNumber)}`,
    loadType: 'hand-load',
    expectedAreaM2: null,
    craneScaleKg: null,
    ...overrides,
  };
}

describe('Matt’s worked example (56:11)', () => {
  /*
   * "one's 1000 square meters and one's 500 square meters. We want to give 2/3
   * of the weight left over to that 1000 square meter job and 1/3 of that weight
   * left over to the 500 square meter job."
   */
  it('splits the leftover 2/3 and 1/3 by size, not equally', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 3000,
      stops: [
        stop({ jobNumber: 1, expectedAreaM2: 1000 }),
        stop({ jobNumber: 2, expectedAreaM2: 500 }),
      ],
    });

    expect(result.remainderKg).toBe(3000);
    expect(result.lines[0]?.imputedKg).toBe(2000);
    expect(result.lines[1]?.imputedKg).toBe(1000);

    expect(result.lines[0]?.shareOfRemainder).toBeCloseTo(2 / 3, 5);
    expect(result.lines[1]?.shareOfRemainder).toBeCloseTo(1 / 3, 5);
  });

  it('deducts crane-weighed bagged jobs before splitting the rest', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 2700,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 700, expectedAreaM2: 300 }),
        stop({ jobNumber: 2, expectedAreaM2: 1000 }),
        stop({ jobNumber: 3, expectedAreaM2: 1000 }),
      ],
    });

    expect(result.measuredKg).toBe(700);
    expect(result.remainderKg).toBe(2000);

    // The bagged job keeps its measured figure and takes no share of the split.
    expect(result.lines[0]?.measuredKg).toBe(700);
    expect(result.lines[0]?.imputedKg).toBeNull();
    expect(result.lines[1]?.imputedKg).toBe(1000);
    expect(result.lines[2]?.imputedKg).toBe(1000);
  });
});

describe('the split adds up', () => {
  /*
   * The docket is the audited figure. Rounding each share independently leaves
   * a total that disagrees with it by a kilogram or two, which is exactly the
   * kind of discrepancy nobody can explain a year later.
   */
  it('apportions every kilogram, even when the shares do not divide evenly', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1000,
      stops: [
        stop({ jobNumber: 1, expectedAreaM2: 333 }),
        stop({ jobNumber: 2, expectedAreaM2: 333 }),
        stop({ jobNumber: 3, expectedAreaM2: 334 }),
      ],
    });

    const total = result.lines.reduce((sum, line) => sum + (line.imputedKg ?? 0), 0);
    expect(total).toBe(result.remainderKg);
    expect(total).toBe(1000);
  });

  it('returns whole kilograms only', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1001,
      stops: [
        stop({ jobNumber: 1, expectedAreaM2: 777 }),
        stop({ jobNumber: 2, expectedAreaM2: 111 }),
      ],
    });

    for (const line of result.lines) {
      if (line.imputedKg !== null) expect(Number.isInteger(line.imputedKg)).toBe(true);
    }
  });
});

describe('a missing area is not zero', () => {
  /*
   * ⚠️ Matt, 31:22 — the fixed-price builder's PO carries no square metres. A
   * stop with no area must be EXCLUDED from the split. Reading it as zero would
   * give it nothing and silently hand its share to everyone else, on a figure
   * that ends up on a certificate.
   */
  it('excludes a stop with no area rather than giving it nothing', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 900,
      stops: [
        stop({ jobNumber: 1, expectedAreaM2: 600 }),
        stop({ jobNumber: 2, expectedAreaM2: 300 }),
        stop({ jobNumber: 3, expectedAreaM2: null }),
      ],
    });

    expect(result.handLoadAreaM2).toBe(900);
    expect(result.lines[0]?.imputedKg).toBe(600);
    expect(result.lines[1]?.imputedKg).toBe(300);
    expect(result.lines[2]?.imputedKg).toBeNull();

    // And it says so, because a driver should know a stop was left out.
    expect(result.warning).toMatch(/no expected m²/);
    expect(result.looksWrong).toBe(false);
  });

  it('refuses to split at all when no hand load has an area', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 900,
      stops: [stop({ jobNumber: 1 }), stop({ jobNumber: 2 })],
    });

    // An equal split would be a different claim, indistinguishable from a real
    // one later. Refusing is the honest outcome.
    expect(result.looksWrong).toBe(true);
    expect(result.warning).toMatch(/cannot be split by size/);
    expect(result.lines.every((line) => line.imputedKg === null)).toBe(true);
  });

  /*
   * ⚠️ A bagged job nobody weighed is still on the truck and still in the
   * docket. It used to take no share, so the hand load beside it was credited
   * with both jobs' board — every bagged job for an m²-only account, which is
   * never asked for kilograms. It now shares the leftover by size, as an
   * estimate, exactly like a hand load.
   */
  it('shares the leftover with a bagged job that was never weighed', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1000,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: null, expectedAreaM2: 400 }),
        stop({ jobNumber: 2, expectedAreaM2: 600 }),
      ],
    });

    // Not measured — there is no crane figure to stand behind.
    expect(result.measuredKg).toBe(0);
    expect(result.lines[0]?.measuredKg).toBeNull();
    // 400 : 600 of the 1,000 kg.
    expect(result.lines[0]?.imputedKg).toBe(400);
    expect(result.lines[1]?.imputedKg).toBe(600);
    expect(result.handLoadJobCount).toBe(2);
    expect(result.warning).toBeNull();
  });

  /* The run QA found it on: 1,450 kg, a 600 m² hand load and an 823.41 m² bag. */
  it('splits the QA run by size instead of handing it all to the hand load', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1450,
      stops: [
        stop({ jobNumber: 61312, expectedAreaM2: 600 }),
        stop({ jobNumber: 61313, expectedAreaM2: null }),
        stop({ jobNumber: 61314, loadType: 'bagged', craneScaleKg: null, expectedAreaM2: 823.41 }),
      ],
    });

    expect(result.lines.map((line) => line.imputedKg)).toEqual([611, null, 839]);
    expect(result.warning).toMatch(/1 stop without a crane weight has no expected m²/);
  });

  /* Weighed bags still stand as weighed; only the unweighed share the rest. */
  it('keeps a weighed bag as measured beside an unweighed one', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1500,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 500, expectedAreaM2: 300 }),
        stop({ jobNumber: 2, loadType: 'bagged', craneScaleKg: null, expectedAreaM2: 250 }),
        stop({ jobNumber: 3, expectedAreaM2: 750 }),
      ],
    });

    expect(result.measuredKg).toBe(500);
    expect(result.remainderKg).toBe(1000);
    expect(result.lines[0]).toMatchObject({ measuredKg: 500, imputedKg: null });
    expect(result.lines[1]).toMatchObject({ measuredKg: null, imputedKg: 250 });
    expect(result.lines[2]).toMatchObject({ measuredKg: null, imputedKg: 750 });
  });

  /*
   * A run of nothing but unweighed bags — an m²-only builder's whole day — used
   * to be refused outright ("no hand-load stops to attribute it to").
   */
  it('splits a run where no bag was weighed at all', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 900,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: null, expectedAreaM2: 200 }),
        stop({ jobNumber: 2, loadType: 'bagged', craneScaleKg: null, expectedAreaM2: 100 }),
      ],
    });

    expect(result.looksWrong).toBe(false);
    expect(result.lines.map((line) => line.imputedKg)).toEqual([600, 300]);
  });
});

describe('dockets that do not make sense', () => {
  /*
   * The reason the driver is shown this before committing: a mistyped crane
   * weight is caught while they are still at the weighbridge.
   */
  it('flags crane weights exceeding the weighbridge total', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 500,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 900 }),
        stop({ jobNumber: 2, expectedAreaM2: 400 }),
      ],
    });

    expect(result.looksWrong).toBe(true);
    expect(result.remainderKg).toBe(-400);
    expect(result.warning).toMatch(/more than the weighbridge total/);
    // Nothing is apportioned from a negative remainder.
    expect(result.lines.every((line) => line.imputedKg === null)).toBe(true);
  });

  it('flags a leftover with no hand-load stop to attribute it to', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 2000,
      stops: [stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 500 })],
    });

    expect(result.looksWrong).toBe(true);
    expect(result.warning).toMatch(/no hand-load stops/);
  });

  /*
   * Two scales never agree to the kilogram. On a run where every stop was
   * bagged there is nowhere to put the difference, and refusing it meant the
   * run could only be tipped off when the weighbridge matched the crane
   * exactly — so it never could be.
   */
  describe('an all-bagged run, where the two scales disagree a little', () => {
    const BAGGED = [
      stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 820 }),
      stop({ jobNumber: 2, loadType: 'bagged', craneScaleKg: 610 }),
    ];

    it('accepts a weighbridge a little over the crane total, and gives the difference to no job', () => {
      const result = reconcileTipOff({ ...RUN, totalKg: 1445, stops: BAGGED });

      expect(result.looksWrong).toBe(false);
      expect(result.remainderKg).toBe(15);
      expect(result.warning).toMatch(/within the normal difference/);
      // The crane figures stand exactly as weighed; nothing is imputed.
      expect(result.lines.map((line) => line.measuredKg)).toEqual([820, 610]);
      expect(result.lines.every((line) => line.imputedKg === null)).toBe(true);
    });

    it('accepts a weighbridge a little under the crane total', () => {
      const result = reconcileTipOff({ ...RUN, totalKg: 1420, stops: BAGGED });

      expect(result.looksWrong).toBe(false);
      expect(result.remainderKg).toBe(-10);
    });

    // A mistyped crane weight is still caught at the weighbridge.
    it('still refuses a difference too big to be the scales', () => {
      expect(reconcileTipOff({ ...RUN, totalKg: 1800, stops: BAGGED }).looksWrong).toBe(true);
      expect(reconcileTipOff({ ...RUN, totalKg: 1100, stops: BAGGED }).looksWrong).toBe(true);
    });

    // A hand load cannot weigh less than nothing, so no tolerance applies.
    it('still refuses an overshoot when there are hand loads on the run', () => {
      const result = reconcileTipOff({
        ...RUN,
        totalKg: 1420,
        stops: [...BAGGED, stop({ jobNumber: 3, expectedAreaM2: 300 })],
      });

      expect(result.looksWrong).toBe(true);
    });
  });

  it('is content when the bagged weights account for the whole docket', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1200,
      stops: [
        stop({ jobNumber: 1, loadType: 'bagged', craneScaleKg: 700 }),
        stop({ jobNumber: 2, loadType: 'bagged', craneScaleKg: 500 }),
      ],
    });

    expect(result.remainderKg).toBe(0);
    expect(result.looksWrong).toBe(false);
    expect(result.warning).toBeNull();
  });
});

describe('edges', () => {
  it('handles a single hand-load stop taking the lot', () => {
    const result = reconcileTipOff({
      ...RUN,
      totalKg: 1234,
      stops: [stop({ jobNumber: 1, expectedAreaM2: 800 })],
    });

    expect(result.lines[0]?.imputedKg).toBe(1234);
    expect(result.lines[0]?.shareOfRemainder).toBe(1);
  });

  it('handles an empty run without dividing by zero', () => {
    const result = reconcileTipOff({ ...RUN, totalKg: 0, stops: [] });

    expect(result.remainderKg).toBe(0);
    expect(result.handLoadAreaM2).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.looksWrong).toBe(false);
  });

  it('carries the run identity through, since a docket belongs to a run', () => {
    // Matt, 43:50 — two runs in a day produce two dockets on one date.
    const result = reconcileTipOff({ ...RUN, totalKg: 100, stops: [] });

    expect(result.runId).toBe(RUN.runId);
    expect(result.runName).toBe('South Coast morning');
    expect(result.date).toBe('2026-09-10');
  });
});
