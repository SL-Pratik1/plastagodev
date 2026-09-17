import { Types } from 'mongoose';
import { ZONES_COLLECTION, ZoneModel } from './settings.model.js';

/**
 * Naming a zone, for the domains that only ever read one.
 *
 * ── Why this exists as its own module ─────────────────────────────────────
 * Every response that carries a zone now carries its NAME too — that is the
 * decision that keeps the web free of a fetched label map on fifteen screens.
 * The cost is that seven domains suddenly need to turn a `zoneId` into a
 * string, and none of them owns the zone register.
 *
 * The alternatives were worse. Routing it through `settingsService` makes the
 * jobs, dispatch, portal and driver domains depend on a service that depends
 * back on jobs for its own counts. Re-declaring the `$lookup` in each
 * repository means seven copies of a join that must agree about what a missing
 * zone renders as. So: one read-only module, imported directly, doing the one
 * thing — the same latitude `settings.repository` already takes when it counts
 * accounts and jobs.
 *
 * ⚠️ READ-ONLY. Nothing here writes. Zone writes go through
 * `settingsRepository`, which owns the transaction that keeps a zone and its
 * rate rows in step.
 */

/**
 * What a zone renders as when it cannot be found.
 *
 * ⚠️ Not the id, and not blank. A zone cannot actually vanish — they are
 * archived, never deleted — so this only fires on a database somebody has
 * edited by hand, and in that case a bare ObjectId on an invoice or a job row
 * tells nobody anything. Blank reads as "this job has no zone", which is
 * alarming and false.
 */
export const UNKNOWN_ZONE_LABEL = 'Unknown zone';

/**
 * The `$lookup` stages that hang a zone off `zoneId`, for aggregations.
 *
 * `preserveNullAndEmptyArrays` so a row whose zone has gone still comes back: a
 * record that cannot name its zone is one somebody has to be able to SEE in
 * order to fix it, and dropping it would hide the broken row from the only
 * screen that could repair it.
 *
 * Pass a different `localField` for a collection that calls it something else —
 * `accounts.primaryZoneId`, for instance.
 */
export function zoneLookupStages(localField = 'zoneId', as = 'zone'): object[] {
  return [
    { $lookup: { from: ZONES_COLLECTION, localField, foreignField: '_id', as } },
    { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
  ];
}

/** One zone's name, or the fallback above. */
export async function zoneLabelFor(id: Types.ObjectId | string | null): Promise<string> {
  if (id === null) return UNKNOWN_ZONE_LABEL;

  const objectId = typeof id === 'string' ? toObjectId(id) : id;
  if (!objectId) return UNKNOWN_ZONE_LABEL;

  const zone = await ZoneModel.findById(objectId, { label: 1 }).lean<{ label: string }>();
  return zone?.label ?? UNKNOWN_ZONE_LABEL;
}

/**
 * Every zone's name, keyed by id as a string.
 *
 * ⚠️ Loads the WHOLE register, archived included, and is meant to be. Callers
 * are naming rows that already exist — a job list, a run sheet, a report — and
 * a job priced in a zone the office has since retired still has to say which
 * zone that was. Filtering to active zones here would blank exactly the rows
 * most in need of explaining.
 *
 * A handful of documents, so there is nothing to page or cache.
 */
export async function zoneLabels(): Promise<Map<string, string>> {
  const zones = await ZoneModel.find({}, { label: 1 })
    .lean<Array<{ _id: Types.ObjectId; label: string }>>();

  return new Map(zones.map((zone) => [zone._id.toString(), zone.label]));
}

/**
 * The register in display order, for anything that lists zones.
 *
 * Carries the slug as well as the name because the SEEDS resolve by slug — it is
 * the only handle they have, the id being minted by Mongo on first insert.
 */
export async function orderedZones(): Promise<
  Array<{ id: string; slug: string; label: string }>
> {
  const zones = await ZoneModel.find({}, { slug: 1, label: 1, displayOrder: 1 })
    .sort({ displayOrder: 1 })
    .lean<Array<{ _id: Types.ObjectId; slug: string; label: string }>>();

  return zones.map((zone) => ({ id: zone._id.toString(), slug: zone.slug, label: zone.label }));
}

/**
 * A string to an ObjectId, or null.
 *
 * ⚠️ `new Types.ObjectId('sydney')` THROWS rather than returning null, so
 * anything taking an id off the wire has to check first — otherwise a stale
 * bookmark carrying the old slug surfaces as a 500 instead of the 404 it is.
 */
export function toObjectId(value: string): Types.ObjectId | null {
  return /^[0-9a-fA-F]{24}$/.test(value) ? new Types.ObjectId(value) : null;
}
