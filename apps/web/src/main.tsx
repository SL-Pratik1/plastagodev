import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from '@/app/providers';
import { router } from '@/app/router';
import { env } from '@/config/env';
import { api } from '@/lib/api-client';
import { createHttpServices } from '@/services/http/create-http-services';
import { registerServiceWorker } from '@/pwa/register-sw';
import './styles/index.css';

/**
 * Mocks are started BEFORE the first render so no request can escape to a real
 * network while the worker is still registering (§13.2 — days 1–3 run entirely
 * on MSW mock data).
 *
 * The `import.meta.env.DEV` guard is load-bearing, not defensive: Vite replaces
 * it with a literal `false` in a production build, so this whole branch — and
 * MSW's ~420 kB browser bundle with it — is eliminated at build time. Without
 * it, the dynamic import still emits a chunk we would be shipping to customers.
 */
async function startMocks(): Promise<void> {
  if (!import.meta.env.DEV || !env.VITE_ENABLE_MOCKS) return;
  const { worker } = await import('@/mocks/browser');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

/**
 * ⚠️ THE SWAP POINT. This one line decides where every screen's data comes from.
 *
 * It now resolves to the real API. `services/mock/` is gone — every domain has
 * endpoints, and a mock kept beside a working backend is how a screen ends up
 * quietly reading fixtures for a month without anybody noticing.
 *
 * Nothing else in the app changed to make this work: no screen, hook or
 * component imports a URL or the api client directly, which is the whole point
 * of the seam described in `services/README.md`.
 */
const services = createHttpServices(api);

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing from index.html');

void startMocks().then(() => {
  createRoot(container).render(
    <StrictMode>
      <AppProviders services={services}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );

  /*
   * After first paint, and after the mocks.
   *
   * After paint because pixels on screen matter more — to a driver standing in
   * the sun and to an office user opening a grid — than pre-caching the shell a
   * few hundred milliseconds sooner.
   *
   * After the mocks because MSW installs its own service worker in dev. Racing
   * the two registrations is how one silently wins and the other never
   * activates, which presents as "the offline shell works on some reloads".
   */
  registerServiceWorker();
});
