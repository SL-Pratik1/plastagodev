import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker registration.
 *
 * Registered explicitly rather than auto-injected so the update behaviour is
 * visible in source. `immediate: true` plus `autoUpdate` in `vite.config.ts`
 * means a driver is never stuck on a stale build — they will never be asked to
 * update an app, and a driver on an old version is a support call from a
 * building site.
 *
 * ── The reload is deferred, and that is the important part ────────────────
 * Applying an update means swapping the running bundle, which unmounts whatever
 * is on screen. Doing that under a driver mid-form would lose what they had just
 * typed standing on site — a set of crane weights, a contamination note — with
 * no way to get it back. So the new build is held until the page is being left
 * anyway.
 *
 * ⚠️ Now that this is one app, the office is on the same service worker. That is
 * why `pagehide` rather than a "refresh to update" toast: an update notification
 * is noise on a console someone leaves open all day, and the console reloads
 * often enough that the update lands quickly regardless.
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
