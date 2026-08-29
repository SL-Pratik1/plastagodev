import { useCallback, useEffect, useState } from 'react';
import {
  getDeferredPrompt,
  isIosSafari,
  isStandalone,
  promptInstall,
  subscribeInstallPrompt,
} from './install-prompt';

/**
 * What, if anything, we can offer this browser.
 *
 *   `installed`    already running from the home screen — offer nothing
 *   `ready`        Chromium handed us a prompt; one tap installs
 *   `instructions` iOS, where the gesture is manual and we can only describe it
 *   `unavailable`  desktop Firefox, an in-app webview, a browser that has not
 *                  decided yet — show nothing rather than a dead button
 */
export type InstallState = 'installed' | 'ready' | 'instructions' | 'unavailable';

export interface InstallApi {
  state: InstallState;
  /**
   * Fires the native prompt. Resolves to what the person chose so the caller can
   * react — a toast on accept, silence on dismiss.
   */
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

/**
 * The install affordance, as a piece of state a component can render.
 *
 * ── Why `unavailable` is a first-class answer ─────────────────────────────
 * Installability is not knowable synchronously. Chromium withholds
 * `beforeinstallprompt` until it has checked the manifest, the service worker
 * and (historically) an engagement heuristic, so the honest first answer on a
 * capable browser is "not yet". Rendering a disabled button through that window
 * teaches people the feature is broken; rendering nothing and then appearing is
 * the behaviour every well-behaved install button has.
 *
 * The subscription is what makes the late arrival land — the module-scope
 * listener in `install-prompt.ts` catches the event whenever it comes and this
 * hook re-reads.
 */
export function useInstallState(): InstallApi {
  const [state, setState] = useState<InstallState>(() => resolveState());

  useEffect(() => {
    const sync = () => {
      setState(resolveState());
    };

    const unsubscribe = subscribeInstallPrompt(sync);

    // The other way `installed` becomes true: someone installs from the
    // browser's own menu while the tab stays open, and the display mode of THIS
    // document never changes — but a standalone window opens alongside it. The
    // media query is still the right listener; it fires in the installed window.
    const displayMode = window.matchMedia('(display-mode: standalone)');
    displayMode.addEventListener('change', sync);

    return () => {
      unsubscribe();
      displayMode.removeEventListener('change', sync);
    };
  }, []);

  const install = useCallback(async () => {
    const outcome = await promptInstall();
    setState(resolveState());
    return outcome;
  }, []);

  return { state, install };
}

function resolveState(): InstallState {
  if (isStandalone()) return 'installed';
  if (getDeferredPrompt()) return 'ready';
  // Checked AFTER the deferred prompt so a Chromium browser that somehow
  // matched the iOS heuristic still gets the real thing.
  if (isIosSafari()) return 'instructions';
  return 'unavailable';
}
