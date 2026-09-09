/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed client environment. Keep in step with the Zod schema in
 * `src/config/env.ts` — the schema is the runtime guard, this is the editor's.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_MOCKS?: 'true' | 'false';
  /** The driver app's own origin. Empty = served from this app at /driver. */
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
