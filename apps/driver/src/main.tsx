import { ToastProvider } from '@plastago/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { AppProviders } from '@/app/providers';
import { router } from '@/app/router';
import { AuthProvider } from '@/features/auth/auth-provider';
import { registerServiceWorker } from '@/pwa/register-sw';
import { api } from '@/lib/api-client';
import { createHttpDriverServices } from '@/services/http/create-http-services';
import { ServicesProvider } from '@/services/services-context';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root element is missing from index.html');

/**
 * ⚠️ THE SWAP POINT.
 *
 * Now running against the real backend. Nothing else changed: no screen imports
 * a URL, and the outbox already spoke HTTP through `offline/transport.ts` — the
 * mock only replaced the send, so deleting it left the queue untouched.
 */
const services = createHttpDriverServices(api);

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
