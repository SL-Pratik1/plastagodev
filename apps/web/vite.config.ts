import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
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
   * lazily-loaded screen.
   */
  optimizeDeps: {
    include: ['recharts', '@tanstack/react-table', 'react-hook-form', '@hookform/resolvers/zod'],
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
          if (id.includes('@tanstack')) return 'tanstack';
          return null;
        },
      },
    },
  },
});
