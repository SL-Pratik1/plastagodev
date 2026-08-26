import { ToastProvider } from '@plastago/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from '@/app/providers';
import { router } from '@/app/router';
import { AuthProvider } from '@/features/auth/auth-provider';
import { registerServiceWorker } from '@/pwa/register-sw';
import { createMockDriverServices } from '@/services/mock/create-mock-services';
import { ServicesProvider } from '@/services/services-context';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing from index.html');

/**
 * ⚠️ THE SWAP POINT.
 *
 * `createMockDriverServices()` becomes `createHttpDriverServices(api)` and this
 * app is running against the real backend. Nothing else changes: no screen
 * imports a URL, and the outbox already speaks HTTP through
 * `offline/transport.ts` — the mock only replaces the send.
 */
const services = createMockDriverServices();

createRoot(container).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <AppProviders>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </AppProviders>
    </ServicesProvider>
  </StrictMode>,
);

// After first paint: pixels on screen matter more to a driver standing in the
// sun than pre-caching the shell a few hundred milliseconds sooner.
registerServiceWorker();
