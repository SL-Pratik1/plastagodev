import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker registration.
 *
 * Registered explicitly rather than auto-injected so the update behaviour is
 * visible in source. `immediate: true` plus `autoUpdate` means a driver is never
 * stuck on a stale build — they will never be asked to update an app, and a
 * driver on an old version is a support call from a building site.
 *
 * The reload is deliberately deferred to the next navigation: reloading under a
 * driver mid-form would lose whatever they had just typed on site.
 */
export function registerServiceWorker(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // A new build is waiting. Apply it on the next navigation, not now.
      window.addEventListener(
        'pagehide',
        () => {
          void updateSW(true);
        },
        { once: true },
      );
    },
    onOfflineReady() {
      console.warn('[pwa] offline shell ready');
    },
    onRegisterError(error) {
      console.error('[pwa] service worker registration failed', error);
    },
  });
}
