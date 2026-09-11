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

/**
 * The ceiling on any direct-to-storage upload — 20 MB.
 *
 * A modern phone photo is 3–5 MB; a burst of HEIC frames is not. Declared here
 * rather than in the API because the number is part of the contract: it is
 * signed into every presigned upload URL, and a file picker that accepts more
 * than the signature allows is a picker that wastes somebody's upload.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
