import { createContext, useContext } from 'react';
import type { Services } from './types.js';

/**
 * Services reach components through context, not a module-level singleton.
 *
 * Two reasons, both practical: a test can mount a screen with a stub service
 * and no network, and the mock-to-HTTP swap happens at one call site instead of
 * inside every module that imported the singleton.
 */
export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error('useServices must be used inside <ServicesProvider>');
  }
  return services;
}
