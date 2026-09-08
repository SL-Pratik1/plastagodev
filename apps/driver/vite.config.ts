import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),

    /**
     * The driver PWA is a SEPARATE Vite app precisely because of this plugin:
     * the service worker and offline shell need their own build configuration
     * (§6A.5).
     *
     * `registerType: 'autoUpdate'` matters operationally — drivers will never
     * be asked to update an app, and a driver stuck on a stale build is a
     * support call from a building site.
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
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        name: 'PlastaGo Driver',
        short_name: 'PG Driver',
        description: 'Run sheets, job status, photos and weights — works offline.',
        theme_color: '#1f7a4d',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Drivers open the app in greenfield estates with no coverage; the shell
        // must be served from cache, always.
        navigateFallback: 'index.html',
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // API responses are NOT cached by the service worker. Offline reads come
        // from IndexedDB via Dexie, and offline writes from the outbox — a cached
        // stale run sheet masquerading as live data is worse than no data.
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/readyz/],
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
       * Resolved to SOURCE rather than `dist` — see the long note in
       * `apps/web/vite.config.ts`. Both apps need it, or the driver app keeps
       * the page-reload bug the console just lost.
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

  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/readyz': { target: API_TARGET, changeOrigin: true },
    },
  },

  preview: { port: 5174, strictPort: true },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // Drivers load this over patchy mobile data, so splitting the stable
    // vendor code from app code means an update re-downloads only what changed.
    // Vite 8 is Rolldown-based: manualChunks must be the FUNCTION form.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return null;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/.test(id)) return 'react';
          if (id.includes('dexie')) return 'dexie';
          if (id.includes('@tanstack')) return 'tanstack';
          return null;
        },
      },
    },
  },
});
