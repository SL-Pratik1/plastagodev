import { describe, expect, it } from 'vitest';
import { distanceKm } from '../src/lib/geo.js';

/**
 * Distance between two points (I3).
 *
 * This decides one thing: whether a geocoded pin is plausibly in the suburb
 * somebody picked. The tolerance is tens of kilometres, so the assertions below
 * are loose on purpose — a test that pinned the sixth decimal would be testing
 * the earth's radius constant rather than the decision this function feeds.
 */
describe('distance between two points', () => {
  const KELLYVILLE = { latitude: -33.7118, longitude: 150.9542 };
  const MELBOURNE = { latitude: -37.8136, longitude: 144.9631 };

  it('is zero for the same point', () => {
    expect(distanceKm(KELLYVILLE, KELLYVILLE)).toBe(0);
  });

  /*
   * ⚠️ The case the drift check exists to catch: Google answering a Sydney
   * address with a real street of the same name in Victoria. ~700km, which is
   * nowhere near any sane threshold.
   */
  it('puts Melbourne hundreds of kilometres from Kellyville', () => {
    expect(distanceKm(KELLYVILLE, MELBOURNE)).toBeGreaterThan(650);
    expect(distanceKm(KELLYVILLE, MELBOURNE)).toBeLessThan(750);
  });

  it('is the same in either direction', () => {
    expect(distanceKm(KELLYVILLE, MELBOURNE)).toBeCloseTo(distanceKm(MELBOURNE, KELLYVILLE), 6);
  });

  /* A tenth of a degree of latitude is ~11km anywhere on earth. */
  it('reads a neighbouring suburb as a few kilometres', () => {
    const boxHill = { latitude: -33.6118, longitude: 150.9542 };

    expect(distanceKm(KELLYVILLE, boxHill)).toBeGreaterThan(10);
    expect(distanceKm(KELLYVILLE, boxHill)).toBeLessThan(12);
  });

  /*
   * Sydney is a long way from the antimeridian, but the formula is shared and a
   * longitude that wraps is the classic way a naive one returns nonsense.
   */
  it('handles a pair that straddles the antimeridian', () => {
    const west = { latitude: 0, longitude: 179.9 };
    const east = { latitude: 0, longitude: -179.9 };

    expect(distanceKm(west, east)).toBeLessThan(25);
  });
});
