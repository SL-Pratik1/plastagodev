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
 */
export interface BrandOption {
  id: string;
  name: string;
  /** Shown in the switcher so the scope of a filter is unambiguous. */
  description: string;
  /** Whether it is trading today, which the switcher dims if not. */
  status: 'live' | 'planned';
}

export const BRANDS: readonly BrandOption[] = [
  { id: 'plastago', name: 'PlastaGo', description: 'Plasterboard recycling', status: 'live' },
  { id: 'easylift', name: 'EasyLift', description: 'Crane and lift services', status: 'live' },
  { id: 'brickgo', name: 'BrickGo', description: 'Registered April 2026', status: 'planned' },
];

/** Sentinel for "don't filter" — the default for a super admin. */
export const ALL_BRANDS = 'all' as const;

/**
 * A brand id, or `ALL_BRANDS`.
 *
 * Just `string` rather than `typeof ALL_BRANDS | string`, which collapses to
 * `string` anyway. A literal union of the three ids would be tighter, but the
 * brand list becomes server data once `/admin/brands` is built, so pretending
 * the set is closed would be a type that has to be unwound.
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
