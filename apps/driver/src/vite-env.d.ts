/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed client environment.
 *
 * Every value here is inlined into the bundle by Vite and is therefore PUBLIC.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Maps Embed API key (I3). Empty = the driver hands off to their maps app. */
  readonly VITE_GOOGLE_MAPS_EMBED_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
