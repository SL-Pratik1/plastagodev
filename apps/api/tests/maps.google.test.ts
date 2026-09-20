import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Google Maps provider (I3).
 *
 * ── Why this is tested against a stubbed `fetch` and never the real API ────
 * Every geocode and every route is BILLED per request. A suite that reaches
 * Google spends the client's money on every commit and every CI run, and the
 * one thing worse than an untested integration is a tested one somebody turned
 * off because of the invoice. So `fetch` is replaced wholesale and the assertion
 * that it was NOT called is itself part of several tests.
 *
 * ── What is actually worth testing here ───────────────────────────────────
 * Not "does Google work". Two things that are ours to get wrong:
 *   1. The waypoint indices come back as positions in the INTERMEDIATES array,
 *      not in the stop list. Reading them as the latter produces a plausible
 *      route that is wrong by one stop at every position.
 *   2. Every way a response can be unusable has to land on `null`, because the
 *      callers treat null as "carry on without me" and anything else as a
 *      route a driver will follow.
 */

const KEY = 'test-key-not-a-real-credential';

/*
 * The key is overridden rather than read from the environment, so this file
 * cannot accidentally hold — or spend — the client's real credential. Partial,
 * because `env.ts` exports more than `env` and the logger reads one of them.
 */
vi.mock('../src/config/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env.js')>();
  return {
    ...actual,
    env: { ...actual.env, MAPS_PROVIDER: 'google', GOOGLE_MAPS_EMBED_API_SERVER: KEY },
  };
});

const { createGoogleMapsProvider } = await import('../src/integrations/google-maps.js');

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response body, wrapped the way `fetch` hands it over. */
function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

const ADDRESS = {
  addressLine: '46 Allambie Circuit',
  suburb: 'Kellyville',
  postcode: '2155',
  state: 'NSW',
};

/** `count` stops in a line, ids `s0`…`s{n}`. */
function stops(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s${String(index)}`,
    latitude: -33.7 - index / 100,
    longitude: 150.9 + index / 100,
  }));
}

describe('geocoding an address', () => {
  it('returns the coordinates and precision of the first result', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        status: 'OK',
        results: [
          {
            formatted_address: '46 Allambie Cct, Kellyville NSW 2155, Australia',
            geometry: {
              location: { lat: -33.7035, lng: 150.9431 },
              location_type: 'ROOFTOP',
            },
          },
        ],
      }),
    );

    const point = await createGoogleMapsProvider().geocode(ADDRESS);

    expect(point).toEqual({
      latitude: -33.7035,
      longitude: 150.9431,
      precision: 'rooftop',
      formattedAddress: '46 Allambie Cct, Kellyville NSW 2155, Australia',
    });
  });

  /*
   * ⚠️ Without the components filter, "46 Allambie Circuit" matches a street of
   * that name anywhere in the world and Google reports no less confidence for
   * having done so. This is the guard that makes an interstate answer hard
   * rather than merely unlikely.
   */
  it('constrains the search to the country, postcode and suburb', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'ZERO_RESULTS' }));

    await createGoogleMapsProvider().geocode(ADDRESS);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('components')).toBe(
      'country:AU|postal_code:2155|locality:Kellyville',
    );
    expect(url.searchParams.get('key')).toBe(KEY);
  });

  it.each([
    ['ZERO_RESULTS', { status: 'ZERO_RESULTS' }],
    ['REQUEST_DENIED', { status: 'REQUEST_DENIED', error_message: 'API key not authorized' }],
    ['OVER_QUERY_LIMIT', { status: 'OVER_QUERY_LIMIT' }],
    ['INVALID_REQUEST', { status: 'INVALID_REQUEST' }],
  ])('answers null on %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(ok(body));

    await expect(createGoogleMapsProvider().geocode(ADDRESS)).resolves.toBeNull();
  });

  it('answers null on an OK response carrying no coordinates', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'OK', results: [{ geometry: {} }] }));

    await expect(createGoogleMapsProvider().geocode(ADDRESS)).resolves.toBeNull();
  });

  it('answers null on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });

    await expect(createGoogleMapsProvider().geocode(ADDRESS)).resolves.toBeNull();
  });

  /*
   * The timeout arrives as a rejection. It must not propagate: the caller is
   * halfway through booking a job for somebody on the phone.
   */
  it('answers null when the request fails outright', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await expect(createGoogleMapsProvider().geocode(ADDRESS)).resolves.toBeNull();
  });

  it('treats an unrecognised location type as approximate', async () => {
    fetchMock.mockResolvedValueOnce(
      ok({
        status: 'OK',
        results: [
          { geometry: { location: { lat: -33.7, lng: 150.9 }, location_type: 'NEW_THING' } },
        ],
      }),
    );

    // Unknown means "not known to be precise", and `isPrecise` rejects
    // approximate — an unfamiliar value must never open the gate.
    const point = await createGoogleMapsProvider().geocode(ADDRESS);
    expect(point?.precision).toBe('approximate');
  });
});

/**
 * The suburb lookup (M6.3) — what replaced two fields on the admin form.
 *
 * ── Why this is not just `geocode` with a blank address line ──────────────
 * The two ask different questions and disagree about what a good answer is.
 * `geocode` DISCARDS an approximate result, because a locality centroid tells a
 * driver nothing the job did not already know. Here the locality centroid is
 * the entire point, and rejecting it would mean no suburb could ever be added
 * without somebody typing a coordinate — which is the thing this removed.
 */
describe('geocoding a suburb', () => {
  const SUBURB = { suburb: 'Kellyville', postcode: '2155', state: 'NSW' };

  /** The real shape of Google's answer for a locality, trimmed to what is read. */
  function locality(lat: number, lng: number) {
    return ok({
      status: 'OK',
      results: [
        {
          formatted_address: 'Kellyville NSW 2155, Australia',
          geometry: { location: { lat, lng }, location_type: 'APPROXIMATE' },
        },
      ],
    });
  }

  it('accepts an approximate result, because that is what a suburb is', async () => {
    fetchMock.mockResolvedValueOnce(locality(-33.7111451, 150.9550731));

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toEqual({
      latitude: -33.7111451,
      longitude: 150.9550731,
      formattedAddress: 'Kellyville NSW 2155, Australia',
    });
  });

  /*
   * ⚠️ The guard that stops "Richmond" meaning the one in Victoria. Suburb
   * names repeat across the country — it is why this table is keyed on
   * {suburb, postcode} — so the postcode has to be a constraint on the lookup
   * and not merely part of a string Google is free to reinterpret.
   */
  it('constrains the lookup to the country, postcode and suburb', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'ZERO_RESULTS' }));

    await createGoogleMapsProvider().geocodeSuburb(SUBURB);

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get('components')).toBe(
      'country:AU|postal_code:2155|locality:Kellyville',
    );
    expect(url.searchParams.get('address')).toBe('Kellyville NSW 2155, Australia');
    expect(url.searchParams.get('key')).toBe(KEY);
  });

  /*
   * `components` is a filter Google relaxes on a near miss, not a promise. This
   * is the one path where a coordinate is stored without a human ever reading
   * the number, so a pin off the continent is discarded rather than saved.
   */
  it.each([
    ['the northern hemisphere', 33.7111451, 150.9550731],
    ['a longitude off the west coast', -33.7111451, 35.5],
  ])('discards a pin outside Australia — %s', async (_label, lat, lng) => {
    fetchMock.mockResolvedValueOnce(locality(lat, lng));

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toBeNull();
  });

  it.each([
    ['ZERO_RESULTS', { status: 'ZERO_RESULTS' }],
    ['REQUEST_DENIED', { status: 'REQUEST_DENIED', error_message: 'API key not authorized' }],
    ['OVER_QUERY_LIMIT', { status: 'OVER_QUERY_LIMIT' }],
  ])('answers null on %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(ok(body));

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toBeNull();
  });

  it('answers null on an OK response carrying no coordinates', async () => {
    fetchMock.mockResolvedValueOnce(ok({ status: 'OK', results: [{ geometry: {} }] }));

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toBeNull();
  });

  it('answers null on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toBeNull();
  });

  it('answers null when the request fails outright', async () => {
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));

    await expect(createGoogleMapsProvider().geocodeSuburb(SUBURB)).resolves.toBeNull();
  });
});

describe('ordering a run', () => {
  /** A Routes API response that puts the intermediates in `order`. */
  function routed(order: number[]) {
    return ok({ routes: [{ optimizedIntermediateWaypointIndex: order }] });
  }

  /*
   * ⚠️ The bug this test exists for. The indices are positions in the
   * INTERMEDIATES array — [s1, s2, s3] here — not in the five-stop list. Read
   * as the latter, [2, 0, 1] would produce [s0, s3, s1, s2, s4]'s neighbours
   * shifted by one: a route that looks entirely reasonable and visits the
   * stops in an order nobody computed.
   */
  it('maps the returned indices onto the intermediate stops', async () => {
    fetchMock.mockResolvedValueOnce(routed([2, 0, 1]));

    const ordered = await createGoogleMapsProvider().optimiseStopOrder(stops(5));

    expect(ordered).toEqual(['s0', 's3', 's1', 's2', 's4']);
  });

  it('keeps the first and last stop where the allocator put them', async () => {
    fetchMock.mockResolvedValueOnce(routed([1, 0]));

    const ordered = await createGoogleMapsProvider().optimiseStopOrder(stops(4));

    expect(ordered?.[0]).toBe('s0');
    expect(ordered?.at(-1)).toBe('s3');
  });

  it('asks only for the waypoint order, not a whole route', async () => {
    fetchMock.mockResolvedValueOnce(routed([0, 1]));

    await createGoogleMapsProvider().optimiseStopOrder(stops(4));

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const request = init as { headers: Record<string, string>; body: string };

    // A wider field mask bills for legs, durations and polylines that nothing
    // in this codebase reads.
    expect(request.headers['X-Goog-FieldMask']).toBe('routes.optimizedIntermediateWaypointIndex');
    expect(request.headers['X-Goog-Api-Key']).toBe(KEY);

    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.optimizeWaypointOrder).toBe(true);
    // The Routes API refuses optimisation combined with TRAFFIC_AWARE_OPTIMAL.
    expect(body.routingPreference).toBe('TRAFFIC_UNAWARE');
    expect(body.intermediates).toHaveLength(2);
  });

  /*
   * Three stops have a middle of exactly one, which has one possible order.
   * Spending a billed request to be told so is waste, not caution.
   */
  it.each([0, 1, 2, 3])('does not call Google for a run of %i stops', async (count) => {
    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(count))).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a run longer than the API will order, without calling it', async () => {
    // 25 intermediates is the cap; 28 stops is 26 of them.
    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(28))).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('orders a run that sits exactly on the cap', async () => {
    fetchMock.mockResolvedValueOnce(routed([...Array(25).keys()]));

    const ordered = await createGoogleMapsProvider().optimiseStopOrder(stops(27));

    expect(ordered).toHaveLength(27);
  });

  it.each([
    ['a short order', [0]],
    ['a repeated index', [0, 0]],
    ['an index past the end', [0, 9]],
    ['a negative index', [0, -1]],
  ])('discards %s', async (_label, order) => {
    fetchMock.mockResolvedValueOnce(routed(order));

    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(4))).resolves.toBeNull();
  });

  it('answers null when the response carries no route at all', async () => {
    fetchMock.mockResolvedValueOnce(ok({ routes: [] }));

    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(5))).resolves.toBeNull();
  });

  it('answers null on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Routes API has not been used in project'),
      json: () => Promise.resolve({}),
    });

    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(5))).resolves.toBeNull();
  });

  it('answers null when the request fails outright', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await expect(createGoogleMapsProvider().optimiseStopOrder(stops(5))).resolves.toBeNull();
  });
});
