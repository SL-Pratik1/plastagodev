import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type {
  GeocodeRequest,
  GeocodedPoint,
  MapsProvider,
  RouteStop,
  SuburbGeocodeRequest,
  SuburbPin,
} from './maps.js';

const log = logger.child({ module: 'google-maps' });

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

/**
 * How long either call may take before the caller gives up on it.
 *
 * ── Why it is this short ──────────────────────────────────────────────────
 * Both callers are inside a request somebody is waiting on. A geocode is one
 * step of booking a job while a builder is on the phone, and the whole feature
 * is an improvement on a pin we already have — so five seconds of silence is
 * already worse than the fallback. The optimiser gets longer because an
 * allocator pressed a button and expects to wait, and because the work is real.
 */
const GEOCODE_TIMEOUT_MS = 5_000;
const ROUTES_TIMEOUT_MS = 15_000;

/**
 * The most stops the Routes API will order in one request.
 *
 * ⚠️ The limit is on INTERMEDIATE waypoints — the first and last stop are the
 * origin and destination and do not count against it. A run longer than this
 * falls back rather than being silently truncated, which would drop stops off a
 * driver's sheet.
 */
const MAX_INTERMEDIATE_WAYPOINTS = 25;

/**
 * Google's `location_type`, mapped to something this codebase can reason about.
 *
 * ⚠️ `GEOMETRIC_CENTER` is a STREET's midpoint and `APPROXIMATE` is usually the
 * locality's. Both are the same class of answer as the suburb pin the job
 * already carries, which is why `isPrecise` rejects them — see `maps.ts`.
 */
const PRECISION_BY_LOCATION_TYPE: Record<string, GeocodedPoint['precision']> = {
  ROOFTOP: 'rooftop',
  RANGE_INTERPOLATED: 'interpolated',
  GEOMETRIC_CENTER: 'block',
  APPROXIMATE: 'approximate',
};

interface GeocodeResponse {
  status: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    geometry?: {
      location?: { lat?: number; lng?: number };
      location_type?: string;
    };
  }[];
}

type GeocodeResult = NonNullable<GeocodeResponse['results']>[number];

interface ComputeRoutesResponse {
  routes?: { optimizedIntermediateWaypointIndex?: number[] }[];
}

/**
 * One Geocoding call, with every way of not getting an answer collapsed to
 * `null`.
 *
 * Shared by both geocoding methods so the failure handling — the timeout, the
 * HTTP error, and the four statuses below — is written once. What the two do
 * with the RESULT differs; what counts as no result at all does not.
 */
async function firstResult(
  url: URL,
  context: Record<string, unknown>,
): Promise<GeocodeResult | null> {
  let body: GeocodeResponse;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
    if (!response.ok) {
      log.warn({ ...context, status: response.status }, 'geocode HTTP error');
      return null;
    }
    body = (await response.json()) as GeocodeResponse;
  } catch (error) {
    // Includes the timeout. Never rethrown: a booking does not fail because
    // Google was slow — see the note on `MapsProvider`.
    log.warn({ ...context, err: error }, 'geocode request failed');
    return null;
  }

  /*
   * ZERO_RESULTS is an ANSWER, not a fault, and it is the common one in a
   * brand-new estate where the street is younger than Google's data. It is
   * logged at debug so it does not read as an incident; everything else is
   * a real problem worth seeing.
   *
   *   REQUEST_DENIED     — key not authorised for Geocoding, or restricted
   *                        to an IP this server does not have
   *   OVER_QUERY_LIMIT   — the daily cap is doing its job
   */
  if (body.status !== 'OK') {
    const level = body.status === 'ZERO_RESULTS' ? 'debug' : 'warn';
    log[level](
      { ...context, status: body.status, detail: body.error_message },
      'geocode returned no usable result',
    );
    return null;
  }

  return body.results?.[0] ?? null;
}

/** The pin off a result, or null when Google answered without one. */
function coordinatesOf(result: GeocodeResult): { latitude: number; longitude: number } | null {
  const latitude = result.geometry?.location?.lat;
  const longitude = result.geometry?.location?.lng;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
  return { latitude, longitude };
}

/**
 * The same envelope `PlaceWriteSchema` enforces on a hand-typed pin.
 *
 * Generous enough for every state, tight enough that a wrong-hemisphere answer
 * cannot be stored.
 */
function isInAustralia({ latitude, longitude }: { latitude: number; longitude: number }): boolean {
  return latitude >= -44 && latitude <= -9 && longitude >= 112 && longitude <= 154;
}

/**
 * Google Geocoding + Routes, on the server key (I3).
 *
 * ⚠️ NOT the Route Optimization API, despite that being the name in the client
 * setup document. That API authenticates by service account and IAM only and
 * rejects an API key outright, so it cannot be reached with the credential
 * PlastaGo was given. The Routes API does the job asked for — order one
 * vehicle's stops by driving time — takes the key, and is the cheaper of the
 * two. The project needs **Routes API** enabled alongside Geocoding.
 */
export function createGoogleMapsProvider(): MapsProvider {
  const key = env.GOOGLE_MAPS_EMBED_API_SERVER;
  if (!key) throw new Error('GOOGLE_MAPS_EMBED_API_SERVER is required when MAPS_PROVIDER=google');

  return {
    name: 'google',

    async geocode(request: GeocodeRequest): Promise<GeocodedPoint | null> {
      /*
       * The address is sent as ONE string with the components filter beside it.
       *
       * `components` is a hard constraint, not a hint: without it "18 Ashworth
       * Boulevard" matches a street in Victoria as readily as the one in
       * Kellyville, and Google reports neither as less confident than the
       * other. Pinning the country, postcode and locality makes the wrong-state
       * answer impossible rather than merely unlikely — and the caller still
       * distance-checks the result, because a filter that Google relaxes on a
       * near-miss is not a guarantee.
       */
      const url = new URL(GEOCODE_URL);
      url.searchParams.set(
        'address',
        `${request.addressLine}, ${request.suburb} ${request.state} ${request.postcode}`,
      );
      url.searchParams.set(
        'components',
        `country:AU|postal_code:${request.postcode}|locality:${request.suburb}`,
      );
      url.searchParams.set('key', key);

      const first = await firstResult(url, { suburb: request.suburb });
      if (!first) return null;

      const point = coordinatesOf(first);
      if (!point) {
        log.warn({ suburb: request.suburb }, 'geocode OK but carried no coordinates');
        return null;
      }

      return {
        ...point,
        precision: PRECISION_BY_LOCATION_TYPE[first.geometry?.location_type ?? ''] ?? 'approximate',
        formattedAddress: first.formatted_address ?? '',
      };
    },

    async geocodeSuburb(request: SuburbGeocodeRequest): Promise<SuburbPin | null> {
      /*
       * Here the components filter is doing nearly all of the work, and the
       * address string is only there to break ties within it.
       *
       * `postal_code` plus `locality` is what makes "Richmond" mean the one in
       * 2753 rather than the one in Victoria. Suburb names repeat across the
       * country — which is why this table's own unique key is {suburb,
       * postcode} and not the name — so an unconstrained lookup would answer
       * confidently and interstate.
       */
      const url = new URL(GEOCODE_URL);
      url.searchParams.set(
        'address',
        `${request.suburb} ${request.state} ${request.postcode}, Australia`,
      );
      url.searchParams.set(
        'components',
        `country:AU|postal_code:${request.postcode}|locality:${request.suburb}`,
      );
      url.searchParams.set('key', key);

      const first = await firstResult(url, { suburb: request.suburb });
      if (!first) return null;

      const point = coordinatesOf(first);
      if (!point) {
        log.warn({ suburb: request.suburb }, 'suburb geocode OK but carried no coordinates');
        return null;
      }

      /*
       * ⚠️ Deliberately NO `isPrecise` check.
       *
       * This lookup asks for a suburb, so `APPROXIMATE` — the locality centroid
       * — is the correct answer, not a degraded one. That is the whole reason
       * this is a separate method; see the note on `geocodeSuburb` in `maps.ts`.
       *
       * The bounds check stays, and matters more here than anywhere else.
       * `components` is a filter Google relaxes on a near miss rather than a
       * guarantee, and this is the one path where a returned coordinate is
       * stored without a human ever reading the number — so a pin outside
       * Australia is discarded rather than saved and wondered about later.
       */
      if (!isInAustralia(point)) {
        log.warn(
          { suburb: request.suburb, ...point, matched: first.formatted_address },
          'suburb geocode landed outside Australia — discarded',
        );
        return null;
      }

      return { ...point, formattedAddress: first.formatted_address ?? '' };
    },

    async optimiseStopOrder(stops: readonly RouteStop[]): Promise<string[] | null> {
      /*
       * ── Why the first and last stop are held fixed ────────────────────────
       * The Routes API orders the stops BETWEEN an origin and a destination, and
       * PlastaGo knows neither: there is no yard coordinate configured and no
       * transfer station chosen until the driver tips off. Inventing a depot
       * would put a made-up point at one end of every route.
       *
       * So the allocator's own first and last stop stand — they picked where the
       * day starts and where it finishes, which is the part of the plan they
       * actually have information about — and Google orders the middle, which is
       * the part nobody can do in their head. When a yard coordinate exists this
       * becomes exact with no change to the caller.
       */
      if (stops.length < 4) {
        // Two stops have no middle; three have a middle of one. Nothing to
        // order, and a request that cannot change the answer is not worth a
        // billed call.
        log.debug({ stops: stops.length }, 'too few stops to order');
        return null;
      }

      const intermediates = stops.slice(1, -1);
      if (intermediates.length > MAX_INTERMEDIATE_WAYPOINTS) {
        log.warn(
          { stops: stops.length, max: MAX_INTERMEDIATE_WAYPOINTS + 2 },
          'run is longer than the Routes API will order — falling back',
        );
        return null;
      }

      const origin = stops[0];
      const destination = stops[stops.length - 1];
      if (!origin || !destination) return null;

      let body: ComputeRoutesResponse;
      try {
        const response = await fetch(ROUTES_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(ROUTES_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            // Asking for anything beyond the order would bill for a full route
            // — legs, polylines, durations — that nothing here reads.
            'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex',
          },
          body: JSON.stringify({
            origin: toWaypoint(origin),
            destination: toWaypoint(destination),
            intermediates: intermediates.map(toWaypoint),
            travelMode: 'DRIVE',
            optimizeWaypointOrder: true,
            /*
             * ⚠️ Deliberately NOT `TRAFFIC_AWARE_OPTIMAL`: the Routes API
             * refuses waypoint optimisation combined with it. Runs are planned
             * the day before in any case, so live traffic would be answering a
             * question about the wrong day.
             */
            routingPreference: 'TRAFFIC_UNAWARE',
          }),
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          log.warn({ status: response.status, detail }, 'route optimisation HTTP error');
          return null;
        }
        body = (await response.json()) as ComputeRoutesResponse;
      } catch (error) {
        log.warn({ err: error }, 'route optimisation request failed');
        return null;
      }

      const order = body.routes?.[0]?.optimizedIntermediateWaypointIndex;
      if (!order || order.length !== intermediates.length) {
        log.warn(
          { returned: order?.length, expected: intermediates.length },
          'route optimisation returned no usable order',
        );
        return null;
      }

      /*
       * The indices are positions in the INTERMEDIATES array, not in `stops`.
       * Reading them as the latter silently shifts every route by one, which
       * would look like a plausible answer and be the wrong one.
       */
      const middle: string[] = [];
      const seen = new Set<number>();
      for (const index of order) {
        const stop = intermediates[index];
        if (!stop || seen.has(index)) {
          log.warn({ index }, 'route optimisation returned a bad waypoint index');
          return null;
        }
        seen.add(index);
        middle.push(stop.id);
      }

      return [origin.id, ...middle, destination.id];
    },
  };
}

function toWaypoint(stop: RouteStop): unknown {
  return { location: { latLng: { latitude: stop.latitude, longitude: stop.longitude } } };
}
