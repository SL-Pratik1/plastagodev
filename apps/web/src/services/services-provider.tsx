import type { ReactNode } from 'react';
import { ServicesContext } from './services-context';
import type { Services } from './types';

export interface ServicesProviderProps {
  services: Services;
  children: ReactNode;
}

/**
 * Injects the service container.
 *
 * `services` is a prop rather than constructed here so the choice of
 * implementation stays at the application entry point, where it is visible.
 */
export function ServicesProvider({ services, children }: ServicesProviderProps) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}
