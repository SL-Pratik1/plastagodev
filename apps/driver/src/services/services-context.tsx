import type { ReactNode } from 'react';
import { ServicesContext } from './services-context-value';
import type { DriverServices } from './types';

/**
 * The one place the app learns where its data comes from.
 *
 * Same seam as the web app, and for the same reason: swapping the mock for HTTP
 * adapters is a single line in `main.tsx`, and no screen imports a URL. The
 * driver app has an extra dependency on this holding — `apps/driver` and the
 * Flutter app must implement the same protocol (§6A.4), so the interface is the
 * shared artefact and the implementation is not.
 */
export function ServicesProvider({
  services,
  children,
}: {
  services: DriverServices;
  children: ReactNode;
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
