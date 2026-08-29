/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Typed client environment. Keep in step with the Zod schema in
 * `src/config/env.ts` — the schema is the runtime guard, this is the editor's.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ENABLE_MOCKS?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
