import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createGoogleMapsProvider } from './google-maps.js';

const log = logger.child({ module: 'maps' });

/** An address as PlastaGo holds it — the typed line plus the PICKED suburb. */
export interface GeocodeRequest {
  addressLine: string;
  suburb: string;
  postcode: string;
  state: string;
}

/**
 * A pin Google was willing to stand behind.
 *
 * `precision` is carried out of the provider rather than resolved inside it
 * because "is this good enough?" is a PlastaGo question: a street-interpolated
 * pin is excellent for a driver and useless for nothing, while a locality
 * centroid is precisely the suburb pin the job already had.
 */
export interface GeocodedPoint {
  latitude: number;
  longitude: number;
  /** What Google matched. See `isPrecise` — only the first two are usable. */
  precision: 'rooftop' | 'interpolated' | 'block' | 'approximate';
  /** Google's own rendering of what it thinks the address is. Logged, not stored. */
  formattedAddress: string;
}

/**
 * A suburb as an administrator names it (M6.3).
 *
 * No `addressLine`, because there is not one. This asks "where is Kellyville?",
 * not "where is 18 Ashworth Bvd, Kellyville?" — a different question with a
 * different right answer.
 */
export interface SuburbGeocodeRequest {
  suburb: string;
  postcode: string;
  state: string;
}

/** The centre of a suburb, for the row the whole pricing chain hangs off. */
export interface SuburbPin {
  latitude: number;
  longitude: number;
  /** Google's own rendering of the suburb it matched. Logged, not stored. */
  formattedAddress: string;
}

/** A stop as the optimiser sees it: an id and a point, nothing else. */
export interface RouteStop {
  id: string;
  latitude: number;
  longitude: number;
}

/**
 * Google, behind an interface (I3).
 *
 * ── Why every method can answer "no" ──────────────────────────────────────
 * Both callers are in the middle of something a person is waiting on — an
 * office user booking a job on the phone, an allocator building tomorrow. A
 * geocode that throws would fail the booking; a route that throws would fail
 * the run. Neither feature is worth that: the suburb pin and the allocator's
 * own ordering are the behaviour this platform shipped with and both remain
 * correct. So a failure returns `null` and the caller carries on.
 *
 * ⚠️ `null` means "no answer", never "the answer is the fallback". The caller
 * has to decide what to do with it, and both of them record which they used.
 */
export interface MapsProvider {
  /** For logs and `/readyz`, so it is obvious which provider is live. */
  readonly name: string;
  /** Null when Google declined, failed, or answered no better than the suburb. */
  geocode: (request: GeocodeRequest) => Promise<GeocodedPoint | null>;
  /**
   * The centre of a suburb, so an administrator never types a coordinate.
   *
   * ⚠️ A SECOND method, not a flag on `geocode`, and the difference is the
   * whole reason it exists. `geocode` discards an `approximate` result because
   * a locality centroid is no better than the suburb pin the job already holds
   * — see `isPrecise`. Here that centroid IS the answer being asked for. One
   * method serving both would have to mean opposite things about the same
   * result, and `isPrecise` would stop being safe to read at a glance.
   *
   * Null when Google has no answer, or when no provider is configured. The
   * caller decides what that means; for the suburb register it means falling
   * back to asking for the pin, never to a guess.
   */
  geocodeSuburb: (request: SuburbGeocodeRequest) => Promise<SuburbPin | null>;
  /**
   * The same stop ids, in driving order. Null when no route was computed.
   *
   * ⚠️ The returned array is a PERMUTATION of what went in — the caller
   * asserts this rather than trusting it, because a dropped stop would silently
   * disappear off a driver's sheet.
   */
  optimiseStopOrder: (stops: readonly RouteStop[]) => Promise<string[] | null>;
}

/**
 * Whether a pin is worth storing over the suburb centroid.
 *
 * `block` and `approximate` are Google saying "somewhere around here" — a
 * street's midpoint or the locality's, which is the same class of answer the
 * job already holds. Storing one would swap a pin we can explain for a pin we
 * cannot, and would mark the job as precisely located when it is not.
 */
export function isPrecise(point: GeocodedPoint): boolean {
  return point.precision === 'rooftop' || point.precision === 'interpolated';
}

/**
 * Answers "no" to everything, and says so once at boot rather than per call.
 *
 * This is the default and the behaviour PlastaGo has always had: jobs take the
 * pin of their chosen suburb and `optimiseRun` groups by suburb. The point of
 * the stub is that neither feature has to be conditional at the call site.
 */
function createOffProvider(): MapsProvider {
  return {
    name: 'off',
    geocode() {
      log.debug('geocode skipped (MAPS_PROVIDER=off)');
      return Promise.resolve(null);
    },
    geocodeSuburb() {
      log.debug('suburb geocode skipped (MAPS_PROVIDER=off)');
      return Promise.resolve(null);
    },
    optimiseStopOrder() {
      log.debug('route optimisation skipped (MAPS_PROVIDER=off)');
      return Promise.resolve(null);
    },
  };
}

/** Built once at boot, like the mailer — see `messaging.ts`. */
let provider: MapsProvider | undefined;

export function getMapsProvider(): MapsProvider {
  provider ??= env.MAPS_PROVIDER === 'google' ? createGoogleMapsProvider() : createOffProvider();
  return provider;
}

/** Test seam: swap in a recording double without touching the environment. */
export function setMapsProviderForTests(override: MapsProvider): void {
  provider = override;
}

export function resetMapsProvider(): void {
  provider = undefined;
}
