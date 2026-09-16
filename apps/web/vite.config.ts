import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
// eslint-disable-next-line import/extensions -- plain .mjs, shared with scripts/
import { devPorts, surfaceOrigins } from '../../scripts/dev-ports.mjs';

/**
 * WHICH SURFACE THIS SERVER IS.
 *
 * One codebase, started up to three times — the office console, the customer
 * portal and the driver app each get their own port here and their own hostname
 * in production. `PLASTAGO_SURFACE` is what tells a given process which one it
 * is; `npm run dev` sets it three times over.
 *
 * `all` is the fourth, legacy value: every surface on one port, which is how
 * this app worked before the split and what `PLASTAGO_SURFACES=all` still does. It
 * stays supported because three Vite dev servers cost three times the memory
 * and three dependency pre-bundles, and on a laptop that is sometimes the wrong
 * trade for a change that touches one screen.
 */
const SURFACE = (process.env.PLASTAGO_SURFACE ?? 'all') as 'admin' | 'portal' | 'driver' | 'all';

const VALID_SURFACES = ['admin', 'portal', 'driver', 'all'] as const;
if (!VALID_SURFACES.includes(SURFACE)) {
  throw new Error(
    `PLASTAGO_SURFACE must be one of ${VALID_SURFACES.join(', ')} — got "${SURFACE}".`,
  );
}

const PORTS = devPorts();
const ORIGINS = surfaceOrigins(PORTS);

/** `all` shares the console's port, which is the address everyone already knows. */
const PORT = SURFACE === 'all' ? PORTS.admin : PORTS[SURFACE];

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? `http://localhost:${PORTS.api}`;

/**
 * Hand the split to the browser, through the ordinary `VITE_*` channel.
 *
 * Vite folds prefixed variables from `process.env` into `import.meta.env`
 * alongside the ones it reads from `.env`, so writing them here — before the
 * config is resolved — is enough for both the dev server and a build.
 *
 * ⚠️ NOT `define`. The obvious spelling, `define: { 'import.meta.env.VITE_SURFACE': … }`,
 * silently does nothing in the dev server: `import.meta.env` is a real object
 * there, not text to rewrite, and a bare `__SURFACE__` global is left
 * untouched by this Vite's dev transform as well. Either way the value read
 * back as undefined, every surface fell through to `all`, and all three ports
 * served all three surfaces — while `npm run build` was correct. That is the
 * worst shape a bug can have, so it is written down rather than rediscovered.
 *
 * These are derived values, which is why they are not variables in `.env`: the
 * port map has already resolved any override, and a second copy of the same
 * numbers is exactly the drift `check:ports` exists to catch.
 */
process.env.VITE_SURFACE = SURFACE;
process.env.VITE_SURFACE_ORIGINS = JSON.stringify(ORIGINS);

/**
 * The installable app each surface offers.
 *
 * ── Why this is per-surface and not one manifest ──────────────────────────
 * A browser will only ever install the page it is already on, and it installs
 * it under the name and icon in THAT page's manifest. While all three surfaces
 * shared one manifest they also shared one name, so a driver installing from
 * their run sheet got an icon labelled "PlastaGo" that opened the office
 * console's landing route. Splitting the surfaces by origin is what makes a
 * per-surface manifest possible, and the manifest is most of the reason the
 * split is worth having.
 *
 * `scope: '/'` still, on each origin — each surface IS the whole of its own
 * origin now, so the scope that once had to cover three prefixes covers one.
 */
const MANIFESTS = {
  admin: {
    name: 'PlastaGo Console',
    short_name: 'PlastaGo',
    description: 'Jobs, dispatch, invoicing and reporting for the PlastaGo office.',
    theme_color: '#1b3820',
  },
  portal: {
    name: 'PlastaGo Portal',
    short_name: 'PlastaGo',
    description: 'Book pickups, track jobs and manage your sites and invoices.',
    theme_color: '#1b3820',
  },
  driver: {
    name: 'PlastaGo Driver',
    short_name: 'PG Driver',
    description: 'Run sheets, job status, photos and weights — works offline.',
    theme_color: '#1f7a4d',
  },
  all: {
    name: 'PlastaGo',
    short_name: 'PlastaGo',
    description:
      'Run sheets, job status, photos and weights for drivers — and the office console. Works offline.',
    theme_color: '#1b3820',
  },
}[SURFACE];

/**
 * Chunks the DRIVER never loads.
 *
 * Named here once because two separate things read this list: `manualChunks`
 * below, which puts these libraries in predictably-named files, and the workbox
 * `globIgnores`, which then keeps those files out of the offline precache.
 *
 * ⚠️ STILL LOAD-BEARING AFTER THE SURFACE SPLIT, which is easy to assume it is
 * not. Each surface is built separately, but from the same route table — and
 * `app/lazy-pages.tsx` names every page in one module, so Rollup emits every
 * lazy chunk into every build whether that surface routes to it or not. The
 * driver's build therefore still CONTAINS the console's chunks; this list is
 * what keeps the service worker from precaching them onto a phone.
 *
 * Recharts and React Hook Form are the heavy office-only dependencies; not one
 * of the eleven driver screens imports either. Recharts alone is ~384 kB raw,
 * which is the entire argument in one number.
 *
 * Splitting `lazy-pages.tsx` per surface would let tree-shaking drop them from
 * the build outright and make this list redundant. Worth doing; not done.
 *
 * ⚠️ `tables` is PREVENTIVE and currently emits no chunk: `@tanstack/react-table`
 * is a declared dependency but nothing imports it yet — `components/data-table`
 * is hand-rolled. It is listed now because the day someone reaches for it, the
 * grid library would otherwise land in the precached `tanstack` chunk beside
 * React Query, and nobody would notice until a driver's install got 45 kB
 * heavier. A `globIgnores` entry matching nothing costs nothing.
 */
const OFFICE_ONLY_CHUNKS = ['charts', 'tables', 'forms'] as const;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    /**
     * One service worker and one manifest PER SURFACE (§6A.5).
     *
     * ── Why this is per-surface and not per-app ───────────────────────────
     * `beforeinstallprompt` is only ever delivered to a document whose OWN
     * manifest scope contains it: nothing in the platform installs somebody
     * else's app. That rule is why the driver screens were folded into this
     * codebase, and it is satisfied just as well by the surface split — the
     * driver's origin serves the driver surface and nothing else, so the page
     * offering the install and the app being installed are the same thing.
     *
     * What the split adds is a manifest that tells the truth. One shared
     * manifest meant one shared name: a driver installing from their run sheet
     * got an icon reading "PlastaGo" that opened the console's landing route.
     * `MANIFESTS` above gives each origin its own name, icon and theme.
     *
     * `scope: '/'` still — each surface is now the whole of its own origin.
     *
     * `registerType: 'autoUpdate'` matters operationally — drivers will never be
     * asked to update an app, and a driver stuck on a stale build is a support
     * call from a building site.
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered explicitly in src/pwa/register-sw.ts
      devOptions: {
        // Lets the offline path be exercised in `npm run dev`, not only in a
        // production build — otherwise offline bugs are found far too late.
        enabled: true,
        type: 'module',
      },
      includeAssets: ['favicon.svg', 'app-icon.svg', 'brand/plastago-mark.png'],
      manifest: {
        // Name, description and colour come from MANIFESTS above — one per
        // surface, because each origin installs as its own app.
        ...MANIFESTS,
        background_color: '#ffffff',
        display: 'standalone',
        // Portrait only on the driver surface: it is a phone app held one-handed
        // on a site, and a run sheet that rotates while someone is climbing out
        // of a truck is a nuisance. The office surfaces are used on a desktop.
        ...(SURFACE === 'driver' ? ({ orientation: 'portrait' } as const) : {}),
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/app-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
          {
            // The raster fallback. Chromium accepts the SVG, but a platform that
            // does not — and Android's own shortcut rendering — needs a real
            // bitmap, and an install can be refused outright without one.
            src: '/brand/plastago-mark.png',
            sizes: '256x256',
            type: 'image/png',
            purpose: 'any',
          },
        ],
      },
      workbox: {
        // Drivers open this in greenfield estates with no coverage; the shell
        // must be served from cache, always.
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        /*
         * ⚠️ THE LINE THAT KEEPS THE CONSOLE OFF A DRIVER'S PHONE.
         *
         * Without it, `globPatterns` above precaches every chunk in the build —
         * Recharts and React Hook Form included, neither of which any driver
         * screen imports. Recharts alone is ~384 kB fetched over site mobile
         * data, at install time, for code that will never run on the device.
         *
         * These are left to ordinary HTTP caching instead: an office user
         * fetches them on first navigation and the browser keeps them. They are
         * the one part of the app an installed copy cannot open offline, which
         * is the right trade — nobody works the dispatch board on a phone with
         * no signal.
         */
        globIgnores: OFFICE_ONLY_CHUNKS.map((chunk) => `**/assets/${chunk}-*.js`),
        // API responses are NOT cached by the service worker. Offline reads come
        // from IndexedDB via Dexie, and offline writes from the outbox — a
        // cached stale run sheet masquerading as live data is worse than no data.
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/readyz/, /^\/openapi\.json/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],

  resolve: {
    /*
     * ⚠️ AN ARRAY, NOT AN OBJECT — the object form matches by PREFIX, so
     * '@plastago/ui' would also capture '@plastago/ui/styles.css' and rewrite it
     * to '<path>/index.ts/styles.css'. The regexes below are anchored, so
     * subpath imports keep resolving through the package's own exports.
     */
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },

      /*
       * ⚠️ THE WORKSPACE PACKAGES RESOLVE TO SOURCE, NOT TO `dist`.
       *
       * Their published exports point at `dist/index.js`, which is right for the
       * API and for a production build. In the dev server it caused a bug that
       * looked like the app itself was broken:
       *
       * `turbo run dev` starts `tsc --watch` for shared, ui and api-client. Each
       * rewrites its ENTIRE `dist/` on the first compile, and they finish up to a
       * minute apart. Vite was watching those emitted files, so every rewrite
       * triggered a full page reload — anyone typing a one-time code during that
       * window lost the form, and the code with it, repeatedly.
       *
       * Pointing at `src` takes `dist` out of the browser's dependency graph
       * entirely: Vite watches real source, HMR is precise instead of a full
       * reload, and the type-checking watchers can emit whenever they like
       * without disturbing anybody.
       */
      {
        find: /^@plastago\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
      {
        find: /^@plastago\/ui$/,
        replacement: fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
      },
      {
        find: /^@plastago\/api-client$/,
        replacement: fileURLToPath(
          new URL('../../packages/api-client/src/index.ts', import.meta.url),
        ),
      },
    ],
  },

  /**
   * Pre-bundle the dependencies that only appear BEHIND a lazy route.
   *
   * Vite scans the eager entry graph at startup to decide what to pre-bundle.
   * Recharts is imported only by the dashboard, which is code-split — so Vite
   * does not see it, discovers it the first time someone navigates there, and
   * re-optimises mid-flight. The in-flight dynamic import then fails with
   * `504 (Outdated Optimize Dep)` and the route renders its error boundary
   * until the page is reloaded.
   *
   * Declaring them here is the documented fix. It costs a little startup time
   * once and removes a first-run failure that looks exactly like a real bug —
   * which is the worst kind of papercut to leave in a demo.
   *
   * Add to this list whenever a heavy dependency ends up used only inside a
   * lazily-loaded screen. Dexie qualifies as of the driver surface landing here:
   * it is reached only from `/driver/*`, which is entirely lazy.
   */
  optimizeDeps: {
    include: [
      'recharts',
      '@tanstack/react-table',
      'react-hook-form',
      '@hookform/resolvers/zod',
      'dexie',
    ],
  },

  server: {
    port: PORT,
    strictPort: true,
    /**
     * Proxying in dev keeps the browser on one origin PER SURFACE, so
     * cookie-based auth behaves as it will in production and there is no CORS
     * preflight in the hot path. Each surface proxies to the same API.
     */
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/readyz': { target: API_TARGET, changeOrigin: true },
      '/openapi.json': { target: API_TARGET, changeOrigin: true },
    },
  },

  preview: { port: PORT, strictPort: true },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // The office lives in grids all day; a slow first paint is felt. Split the
    // heavy, rarely-changing libraries so they cache independently of app code.
    //
    // Vite 8 is Rolldown-based and only accepts the FUNCTION form of
    // manualChunks — the object form was removed.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return null;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/.test(id)) return 'react';
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          /*
           * ── Split BEFORE the general `@tanstack` rule ──────────────────
           * React Table is office-only and heavy; React Query is used by every
           * surface, the driver's included. Without this line first, the broad
           * `@tanstack` rule below would swallow both and bury the grid library
           * inside a chunk the service worker precaches — which is exactly what
           * `OFFICE_ONLY_CHUNKS` exists to prevent. Inert today (nothing imports
           * react-table yet); load-bearing the moment something does.
           *
           * Matched with a separator CLASS, not a `/` literal: module ids carry
           * NATIVE separators, so on Windows this path arrives with backslashes
           * and `includes('@tanstack/react-table')` silently never matches. That
           * fails in the worst way — the build succeeds and the split quietly
           * does nothing. The `react` rule above uses this form for the same
           * reason.
           */
          if (/@tanstack[\\/]react-table/.test(id)) return 'tables';
          if (id.includes('@tanstack')) return 'tanstack';
          // Office and portal forms. No driver screen uses a form library —
          // they are single-purpose screens with a handful of fields each.
          if (/react-hook-form|@hookform/.test(id)) return 'forms';
          return null;
        },
      },
    },
  },
});
