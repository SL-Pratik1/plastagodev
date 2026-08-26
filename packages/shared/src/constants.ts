/**
 * Cross-surface infrastructure constants.
 * Business constants (rates, zones, statuses) do NOT belong here — they are data.
 */

/** All timestamps are stored UTC and rendered in this zone (§6A.10 #5). */
export const APP_TIMEZONE = 'Australia/Sydney' as const;

/** Persistent data residency — Atlas + S3 (§6A.2). */
export const DATA_REGION = 'ap-southeast-2' as const;

/** Contract version. Bump on any breaking change after the day-3 freeze (§6A.9). */
export const API_VERSION = '1.0.0' as const;

/** Mounted prefix for every versioned route. */
export const API_PREFIX = '/api/v1' as const;

/** The seven roles from M1.5. Declared here so every surface agrees on the strings. */
export const ROLES = [
  'super-admin',
  'operations',
  'office-staff',
  'allocator',
  'driver',
  'customer-administrator',
  'customer-site-supervisor',
] as const;

export type Role = (typeof ROLES)[number];
