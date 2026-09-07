import type { BrandId } from '@plastago/shared';

/**
 * The brands the platform operates.
 *
 * Brand is a first-class dimension on accounts, jobs, invoices, templates,
 * senders and logos — not a setting (M1.1). This is already real in production:
 * TransVirtual holds EasyLift invoice templates and EasyLift has two live POD
 * export rules, and BrickGo was registered under the same ABN in April 2026.
 *
 * Held as configuration for now because there is no brands domain yet. It moves
 * behind a `BrandService` when `/admin/brands` is built; the shell's brand
 * switcher reads from here so that swap touches one file.
 *
 * Only PlastaGo is listed while the platform trades single-brand. EasyLift and
 * BrickGo stay in `BRAND_IDS` and in the fixtures, so records already carrying
 * those ids keep their label and re-listing a brand here is a one-line change.
 */
export interface BrandOption {
  /** A `BrandId`, so this list can only ever name a brand the schema knows. */
  id: BrandId;
  name: string;
  /** Shown in the switcher so the scope of a filter is unambiguous. */
  description: string;
  /** Whether it is trading today, which the switcher dims if not. */
  status: 'live' | 'planned';
}

export const BRANDS: readonly BrandOption[] = [
  { id: 'plastago', name: 'PlastaGo', description: 'Plasterboard recycling', status: 'live' },
];

/**
 * The ids a picker may offer — the configured subset of `BRAND_IDS`.
 *
 * Pickers read this rather than `BRAND_IDS` so that the set a user can *choose*
 * follows this file, while the set the schema will *accept* stays wide enough
 * for the records that already exist.
 */
export const CONFIGURED_BRAND_IDS: readonly BrandId[] = BRANDS.map((brand) => brand.id);

/**
 * False while one brand is configured.
 *
 * A picker with a single option is not a choice, it is a required click, so the
 * forms hide theirs and submit the default instead.
 */
export const IS_MULTI_BRAND = BRANDS.length > 1;

/** Sentinel for "don't filter" — the default for a super admin. */
export const ALL_BRANDS = 'all' as const;

/**
 * A brand id, or `ALL_BRANDS`.
 *
 * Just `string` rather than `typeof ALL_BRANDS | string`, which collapses to
 * `string` anyway. A literal union of the configured ids would be tighter, but
 * the brand list becomes server data once `/admin/brands` is built, so
 * pretending the set is closed would be a type that has to be unwound.
 */
export type BrandSelection = string;

export const BRAND_STORAGE_KEY = 'plastago.brand';

export function brandName(id: BrandSelection): string {
  if (id === ALL_BRANDS) return 'All brands';
  return BRANDS.find((brand) => brand.id === id)?.name ?? 'All brands';
}

/** A user only sees the brands on their own record (`user.brandIds`). */
export function brandsFor(brandIds: readonly string[]): readonly BrandOption[] {
  return BRANDS.filter((brand) => brandIds.includes(brand.id));
}
