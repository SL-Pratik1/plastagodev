/**
 * TransVirtual's 5 "Pricing Zones" → this system's zone slugs.
 *
 * ⚠️ NOT a generic slugify. `seed-settings.ts` already creates zones with
 * slugs `sydney`/`wollongong`/`newcastle` (see `packages/shared/src/schemas/
 * party.ts`'s `SEEDED_ZONE_LABELS`). Naively kebab-casing TransVirtual's own
 * label "Sydney Metro" would produce `sydney-metro` — a second, different
 * Sydney zone that silently fragments every account/job that references it.
 * This table is the explicit, checked alternative.
 *
 * Confirmed against the live TransVirtual "Pricing Zones" listing during the
 * read-only audit (2026-09-22): Central Coast - NSW, Hunter Valley,
 * Newcastle, Sydney Metro, Wollongong.
 *
 * ⚠️ `sydney` (bare, no "Metro") is ALSO a key here, not just `sydney metro`.
 * That's a separate, real value seen on individual consignments' own rating
 * zone (`ConsignmentCustomerPriceFromZone`/`...ToZone`, used by
 * migrate-tv-jobs-invoices.ts) — 2,052 of 5,280 historical jobs, confirmed
 * against the real data. Leaving it out doesn't lose any jobs (the fallback
 * zone is also `sydney`) but does produce a misleading "unrecognised" flag
 * on every one of them — found and fixed during dry-run testing.
 */
export const ZONE_SLUG_MAP: Record<string, string> = {
  sydney: 'sydney',
  'sydney metro': 'sydney',
  'central coast - nsw': 'central-coast',
  'hunter valley': 'hunter-valley',
  newcastle: 'newcastle',
  wollongong: 'wollongong',
};

export interface ZoneMapResult {
  slug: string;
  label: string;
}

/**
 * Approximate zone-centre coordinates — NOT real geocodes.
 *
 * Used only for historical jobs (migrate-tv-jobs-invoices.ts), where
 * PlastaGo's own `places` table has ~0% coverage of the suburbs in 3 years
 * of TransVirtual history (checked directly: 0 of 647 distinct suburb/
 * postcode pairs matched). Precision doesn't matter here the way it does for
 * a live job: these are already-completed deliveries, never re-routed or
 * re-optimised — `locationSource: 'suburb'` already exists in the schema for
 * exactly this "not a real pin" case, and this goes one level coarser
 * (zone-centre, not even suburb-centre), flagged explicitly on every
 * imported job rather than presented as real geocoding.
 */
export const ZONE_CENTRE: Record<string, { latitude: number; longitude: number }> = {
  sydney: { latitude: -33.8688, longitude: 151.2093 },
  'central-coast': { latitude: -33.4269, longitude: 151.342 },
  'hunter-valley': { latitude: -32.7346, longitude: 151.3489 },
  newcastle: { latitude: -32.9283, longitude: 151.7817 },
  wollongong: { latitude: -34.4278, longitude: 150.8931 },
};

/**
 * Resolves a TransVirtual zone name to its target slug and a clean label.
 * Returns `null` for a name this table doesn't recognise — that's a
 * structural surprise (TransVirtual added a zone since this table was
 * written), not a per-row data problem, and should stop the phase rather
 * than mint an unreviewed new zone.
 */
export function resolveZone(tvZoneName: string): ZoneMapResult | null {
  const key = tvZoneName.trim().toLowerCase();
  const slug = ZONE_SLUG_MAP[key];
  if (!slug) return null;
  return { slug, label: tvZoneName.trim() };
}
