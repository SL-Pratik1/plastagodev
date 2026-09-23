import type { FreightItem } from '@plastago/shared';

/**
 * TransVirtual's free-text item description → this system's 5-value
 * `FREIGHT_ITEMS` enum.
 *
 * ⚠️ Grounded in the REAL 18 distinct description combinations seen across
 * all 5,280 historical consignments (2026-09-22 capture) — a two-rule
 * classifier covers 100% of them with no ambiguous cases:
 *
 *   "Hand Load"/"Knauf Hand Load" (any m² band)        → plasterboard-hand-load
 *   "Recycling"/"Bag"/"Residential Recycling ..." etc. → plasterboard-bagged
 *
 * Every observed description falls into exactly one bucket — "Recycling",
 * "Residential Recycling - Stand Alone/Communities" and "Bag" are all
 * naming-era variants of the same bagged-collection product (TransVirtual
 * relabelled this catalog item more than once between 2023 and 2026), and
 * this system's enum doesn't distinguish stand-alone/communities the way
 * TransVirtual's own catalog briefly did.
 *
 * No historical description names a hook-bin size (5/10/15 m³) at all —
 * `hook-bin-5`/`hook-bin-10`/`hook-bin-15` are simply unused by every
 * historical job. That's a real finding, not a gap in this table: those
 * freight items were only added to the live catalog recently (per the
 * platform's own Freight Items config), too new to have accumulated
 * history by this capture date.
 */
export function resolveFreightItem(tvDescription: string): FreightItem | null {
  const desc = tvDescription.trim().toLowerCase();
  if (desc === '') return null;
  if (desc.includes('hand load')) return 'plasterboard-hand-load';
  if (desc.includes('recycling') || desc.includes('bag')) return 'plasterboard-bagged';
  return null;
}
