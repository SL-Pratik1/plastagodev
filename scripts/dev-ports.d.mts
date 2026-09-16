/**
 * Types for `dev-ports.mjs`.
 *
 * The implementation stays plain JavaScript because `scripts/free-ports.mjs`
 * runs it under bare `node`, with no build step and no loader — so the types
 * live here instead, for `vite.config.ts`, which is type-checked.
 */

export type Surface = 'admin' | 'portal' | 'driver';

export interface DevPorts {
  api: number;
  admin: number;
  portal: number;
  driver: number;
}

export declare const REPO_ROOT: string;
export declare const SURFACES: readonly Surface[];
export declare const DEFAULT_LEGACY_DRIVER_APP_PORT: number;
export declare function legacyDriverAppPort(): number;
export declare const DEFAULT_PORTS: Readonly<DevPorts>;

/** The ports THIS checkout is configured for, read from the `.env` files. */
export declare function devPorts(): DevPorts;

/** `http://localhost:5173` etc., keyed by surface. */
export declare function surfaceOrigins(ports?: DevPorts): Record<Surface, string>;

/** `KEY=value` out of a dotenv file, or null when absent. */
export declare function readEnvValue(file: string, key: string): string | null;
