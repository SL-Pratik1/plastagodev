import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

/**
 * Chunks the DRIVER never loads.
 *
 * Named here once because two separate things read this list: `manualChunks`
 * below, which puts these libraries in predictably-named files, and the workbox
 * `globIgnores`, which then keeps those files out of the offline precache.
 *
 * That pairing is the whole answer to the standing objection against folding the
 * driver app back into this one — that a driver's phone would end up caching the
 * console. Recharts and React Hook Form are the heavy office-only dependencies
 * in this build; not one of the eleven driver screens imports either, and so
 * neither reaches a phone. Recharts alone is ~384 kB raw, which is the entire
 * argument in one number.
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
     * One service worker, one manifest, one installable app (§6A.5).
     *
     * ── Why the driver PWA is no longer a separate build ──────────────────
     * It was separate precisely so it could own this plugin. What overturned
     * that is a browser rule rather than a preference: `beforeinstallprompt` is
     * only ever delivered to a document whose OWN manifest scope contains it, so
     * while the driver screens lived on another origin there was no way to put a
     * working Install button in front of a driver who had signed in here.
     * Nothing in the platform installs somebody else's app.
     *
     * `scope: '/'` is what makes that button work from anywhere in the product.
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
        name: 'PlastaGo',
        short_name: 'PlastaGo',
        description:
          'Run sheets, job status, photos and weights for drivers — and the office console. Works offline.',
        // The console's own deep forest green, so an installed window is framed
        // in the brand rather than in the browser's default grey.
        theme_color: '#1b3820',
        background_color: '#ffffff',
        display: 'standalone',
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
    port: 5173,
    strictPort: true,
    /**
     * Proxying in dev keeps the browser on one origin, so cookie-based auth
     * behaves exactly as it will in production (§Scope Call 2: one app at
     * app.plastago.com.au). It also means no CORS preflight in the hot path.
     */
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/readyz': { target: API_TARGET, changeOrigin: true },
      '/openapi.json': { target: API_TARGET, changeOrigin: true },
    },
  },

  preview: { port: 5173, strictPort: true },

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
