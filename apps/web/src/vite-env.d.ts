/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed client environment. Keep in step with the Zod schema in
 * `src/config/env.ts` — the schema is the runtime guard, this is the editor's.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_MOCKS?: 'true' | 'false';
  /**
   * Which surface this build serves: `admin`, `portal`, `driver`, or `all` for
   * the single-server mode. Written into `process.env` by `vite.config.ts` from
   * `PLASTAGO_SURFACE` — never set by hand in a `.env`.
   */
  readonly VITE_SURFACE?: string;
  /** Each surface's localhost origin as JSON, from the dev port map. */
  readonly VITE_SURFACE_ORIGINS?: string;
  /** The office console's origin. Empty = this build serves it too. */
  readonly VITE_ADMIN_APP_URL?: string;
  /** The customer portal's origin. Empty = this build serves it too. */
  readonly VITE_PORTAL_APP_URL?: string;
  /** The driver app's origin. Empty = this build serves it too. */
  readonly VITE_DRIVER_APP_URL?: string;
  /** Maps Embed API key. Empty = the driver hands off to their maps app. */
  readonly VITE_GOOGLE_MAPS_EMBED_KEY?: string;
  /**
   * The 3PM Extractor's base URL, for the embedded Extractor tab. Empty = the
   * tab says it is not configured.
   *
   * ⚠️ The origin only. The embed token is a server-side credential and the API
   * brokers a session id in its place — see `config/extractor.ts`.
   */
  readonly VITE_EXTRACTOR_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
