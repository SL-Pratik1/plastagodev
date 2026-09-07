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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
