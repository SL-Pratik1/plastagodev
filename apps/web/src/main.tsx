import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from '@/app/providers';
import { router } from '@/app/router';
import { env } from '@/config/env';
import { createMockServices } from '@/services/mock/create-mock-services';
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
 * `createMockServices()` resolves every service to in-memory fixtures. When the
 * endpoints exist, this becomes `createHttpServices(api)` and nothing else in the
 * app changes — no screen, hook or component imports a URL or the api client
 * directly. See `services/README.md`.
 *
 * Note this is separate from MSW above, and the two are not redundant. MSW
 * intercepts real HTTP for endpoints that DO exist (`/readyz` today, so the
 * dashboard's status panel exercises the genuine request path). The service
 * container stands in for domains that have no endpoints yet, without inventing
 * paths that would pre-empt the day-3 contract freeze (§6A.9).
 */
const services = createMockServices();

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
});
