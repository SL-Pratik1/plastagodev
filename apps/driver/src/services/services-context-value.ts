import { createContext, useContext } from 'react';
import type { DriverServices } from './types';

/**
 * The context object and its hook, apart from the provider component.
 *
 * Fast refresh only works in a module that exports components and nothing else,
 * so a provider file that also exported `useServices` would disable HMR for
 * every screen — on an app whose whole value is being iterated on quickly.
 */
export const ServicesContext = createContext<DriverServices | null>(null);

export function useServices(): DriverServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesProvider>');
  return services;
}
