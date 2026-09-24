import type { LoadType, TipOffReconciliation } from '@plastago/shared';

/**
 * M4.4 — apportioning a weighbridge docket across the stops on a run.
 *
 * ── The rule, in Matt's words ─────────────────────────────────────────────
 * 56:11: *"we want to split the remaining weight left over over those two jobs
 * **based on how big they are**. So let's say one's 1000 square meters and one's
 * 500 square meters. We want to give 2/3 of the weight left over to that 1000
 * square meter job and 1/3 of that weight left over to the 500 square meter
 * job."*
 *
 * So:
 *   1. Bagged jobs were weighed on the crane scale. Those figures are ACTUAL.
 *   2. Subtract them from the weighbridge total. What remains is everything the
 *      truck hand-loaded.
 *   3. Split that remainder across the hand-load stops in proportion to their
 *      m² — not equally.
 *
 * ── Why this is a pure function ───────────────────────────────────────────
 * These numbers end up on diversion certificates (M9.5 · F52) and EPA RRO14
 * records. They must be identical for the PWA and the Flutter app, reproducible
 * from stored inputs a year later, and testable without a database. Nothing in
 * here reads the clock, the network or Mongo.
 *
 * ⚠️ An equal split would put the same tonnage on a garage and a two-storey
 * house. That figure is printed on a certificate with the customer's name on it.
 */

export interface ReconciliationStop {
  jobId: string;
  jobNumber: number;
  siteName: string;
  loadType: LoadType;
  /**
   * The job's size, as recorded in the office before the truck left.
   *
   * ⚠️ Null when nobody has supplied it — the fixed-price builder's case (Matt,
   * 31:22: *"with this customer, you won't know square meters."*). Null is NOT
   * zero here: a null stop is excluded from the split entirely, whereas a zero
   * would claim a share of nothing and quietly hand its tonnage to everyone
   * else on the run.
   */
  expectedAreaM2: number | null;
  /** From the crane scale. Null on a hand load — there is no bag to lift. */
  craneScaleKg: number | null;
}

export interface ReconciliationInput {
  runId: string;
  runName: string;
  date: string;
  /** The weighbridge figure the driver just read off the docket. */
  totalKg: number;
  stops: readonly ReconciliationStop[];
}

/**
 * Weights are recorded to the kilogram. Carrying fractions would imply the
 * weighbridge measured them, and they would not survive a round trip through a
 * certificate anyway.
 */
function roundKg(value: number): number {
  return Math.round(value);
}

/**
 * How far the weighbridge may differ from the crane scale when there is
 * nowhere to put the difference.
 *
 * ── Why a tolerance exists at all ─────────────────────────────────────────
 * Two scales never agree to the kilogram: a weighbridge reads in 20 kg steps,
 * and a crane scale moves with the bag's swing. On a run where every stop was
 * bagged and weighed, the docket and the crane total differ by a little every
 * time, and there is no hand-load stop to take the difference. With no
 * tolerance, such a run could only be tipped off when the two agreed exactly —
 * which is never — so it could not be closed, and its jobs never reached a
 * certificate. (This became reachable once `loadType` was actually stored;
 * before that every stop reconciled as a hand load.)
 *
 * Inside the tolerance the crane figures stand exactly as weighed — they are
 * measurements of each bag — and the difference goes to no job. Outside it the
 * docket is still refused, because that is a typing mistake, not scale drift.
 */
const SCALE_TOLERANCE = { minimumKg: 20, fraction: 0.05 } as const;

function withinScaleTolerance(differenceKg: number, totalKg: number): boolean {
  return (
    Math.abs(differenceKg) <= Math.max(SCALE_TOLERANCE.minimumKg, totalKg * SCALE_TOLERANCE.fraction)
  );
}

export function reconcileTipOff(input: ReconciliationInput): TipOffReconciliation {
  const bagged = input.stops.filter((stop) => stop.loadType === 'bagged');
  const handLoads = input.stops.filter((stop) => stop.loadType === 'hand-load');

  /*
   * Only bagged stops that were ACTUALLY weighed count as measured. A bagged
   * stop the driver never got a crane figure for is not zero kilograms — it is
   * an unknown, and treating it as zero would inflate the remainder that gets
   * shared out to everybody else.
   */
  const measuredKg = roundKg(
    bagged.reduce((sum, stop) => sum + (stop.craneScaleKg ?? 0), 0),
  );

  const remainderKg = roundKg(input.totalKg - measuredKg);

  /*
   * The denominator. Stops with no area are excluded rather than counted as
   * zero — see the warning on `expectedAreaM2`.
   */
  const splittable = handLoads.filter(
    (stop) => stop.expectedAreaM2 !== null && stop.expectedAreaM2 > 0,
  );
  const handLoadAreaM2 = splittable.reduce((sum, stop) => sum + (stop.expectedAreaM2 ?? 0), 0);

  const { looksWrong, warning } = assess({
    totalKg: input.totalKg,
    measuredKg,
    remainderKg,
    handLoadCount: handLoads.length,
    splittableCount: splittable.length,
    handLoadAreaM2,
  });

  /*
   * Shares are computed against the exact remainder and rounded per line, then
   * the LAST line absorbs the rounding difference. Rounding each share
   * independently leaves a total that disagrees with the docket by a kilogram
   * or two — and the docket is the audited figure.
   */
  const shares = new Map<string, number>();
  if (!looksWrong && handLoadAreaM2 > 0) {
    let allocated = 0;
    splittable.forEach((stop, index) => {
      const isLast = index === splittable.length - 1;
      const share = isLast
        ? remainderKg - allocated
        : roundKg((remainderKg * (stop.expectedAreaM2 ?? 0)) / handLoadAreaM2);
      shares.set(stop.jobId, share);
      allocated += share;
    });
  }

  return {
    runId: input.runId,
    runName: input.runName,
    date: input.date,
    totalKg: input.totalKg,
    measuredKg,
    remainderKg,
    handLoadJobCount: handLoads.length,
    handLoadAreaM2,
    looksWrong,
    warning,
    lines: input.stops.map((stop) => {
      const imputed = shares.get(stop.jobId) ?? null;

      return {
        jobId: stop.jobId,
        jobNumber: stop.jobNumber,
        siteName: stop.siteName,
        loadType: stop.loadType,
        // The contract's `areaM2` is non-nullable, and 0 is the honest reading
        // of "no area supplied" for DISPLAY. The split above already excluded
        // it, so this zero cannot leak into an apportionment.
        areaM2: stop.expectedAreaM2 ?? 0,
        measuredKg: stop.loadType === 'bagged' ? stop.craneScaleKg : null,
        imputedKg: imputed,
        shareOfRemainder:
          imputed !== null && remainderKg > 0 ? imputed / remainderKg : imputed !== null ? 0 : null,
      };
    }),
  };
}

/**
 * Whether this docket makes sense, and what to tell the driver if not.
 *
 * ── Why the driver sees this before committing ────────────────────────────
 * A wildly wrong imputed figure almost always means a mistyped crane weight,
 * and the driver is still standing at the weighbridge. Catching it here costs
 * them ten seconds; catching it at month end means unpicking a certificate.
 */
function assess(input: {
  totalKg: number;
  measuredKg: number;
  remainderKg: number;
  handLoadCount: number;
  splittableCount: number;
  handLoadAreaM2: number;
}): { looksWrong: boolean; warning: string | null } {
  const differenceKg = Math.abs(input.remainderKg);

  // Measured more than the weighbridge saw.
  if (input.remainderKg < 0) {
    /*
     * With nothing hand-loaded, a small overshoot is the two scales
     * disagreeing — see `SCALE_TOLERANCE`. With hand loads on the run it is
     * never that: they would have to weigh less than nothing.
     */
    if (input.handLoadCount === 0 && withinScaleTolerance(input.remainderKg, input.totalKg)) {
      return {
        looksWrong: false,
        warning: `The crane weights come to ${String(input.measuredKg)} kg, ${String(differenceKg)} kg more than the weighbridge total of ${String(input.totalKg)} kg. That is within the normal difference between the two scales, so the crane weights stand.`,
      };
    }

    // Something was typed wrong, and committing it would put negative weight
    // on a certificate.
    return {
      looksWrong: true,
      warning: `The crane weights add up to ${String(input.measuredKg)} kg, which is more than the weighbridge total of ${String(input.totalKg)} kg. Check the docket and the bag weights.`,
    };
  }

  // Weight to share out, but nobody to share it with.
  if (input.remainderKg > 0 && input.handLoadCount === 0) {
    if (withinScaleTolerance(input.remainderKg, input.totalKg)) {
      return {
        looksWrong: false,
        warning: `The weighbridge total is ${String(differenceKg)} kg more than the crane weights. That is within the normal difference between the two scales, so the crane weights stand and the ${String(differenceKg)} kg is not given to any job.`,
      };
    }

    return {
      looksWrong: true,
      warning: `There is ${String(input.remainderKg)} kg left after the bagged jobs, but no hand-load stops on this run to attribute it to. Check the docket and the bag weights.`,
    };
  }

  /*
   * Hand loads exist but none carries an area, so there is no basis for a
   * proportional split. Refusing beats splitting equally: an equal share is a
   * different claim, and it would be indistinguishable from a real one later.
   */
  if (input.remainderKg > 0 && input.handLoadCount > 0 && input.splittableCount === 0) {
    return {
      looksWrong: true,
      warning:
        'None of the hand-load stops on this run has an expected m², so the leftover weight cannot be split by size. Add the areas in the office first.',
    };
  }

  // Not fatal, but worth saying: some stops will get nothing.
  if (input.splittableCount > 0 && input.splittableCount < input.handLoadCount) {
    const missing = input.handLoadCount - input.splittableCount;
    return {
      looksWrong: false,
      warning: `${String(missing)} hand-load ${missing === 1 ? 'stop has' : 'stops have'} no expected m², so ${missing === 1 ? 'it is' : 'they are'} excluded from the split.`,
    };
  }

  return { looksWrong: false, warning: null };
}
