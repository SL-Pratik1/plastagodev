/**
 * Home-screen installation, and the one browser rule that shapes all of it.
 *
 * ── A page can only ever install ITSELF ───────────────────────────────────
 * Chromium fires `beforeinstallprompt` at a document only when that document's
 * OWN manifest is installable — which requires the manifest's `scope` to
 * contain the current URL. There is no API for offering to install a different
 * app: `navigator.getInstalledRelatedApps()` can *detect* one, and that is all.
 *
 * That is precisely why the driver screens were folded into this app rather
 * than left in a second Vite build on another origin. While they lived apart,
 * an "Install the driver app" button in the console was not a thing anyone
 * could write — the event simply never arrives at a page outside the target's
 * scope. One app, one manifest at `scope: '/'`, and the button becomes ordinary.
 *
 * ── Why the listener is registered at module scope ────────────────────────
 * `beforeinstallprompt` fires ONCE, early, and is not replayed. React mounting,
 * hydrating and running effects takes long enough that a listener added inside
 * `useEffect` routinely misses it — the symptom being an Install button that
 * works on a slow reload and never on a fast one, which reads as flakiness
 * rather than a race. So the event is captured here, the moment this module is
 * imported, and held for whatever subscribes later.
 */

/**
 * Chromium's install event. Not in the DOM lib, because it is not standardised —
 * WebKit has declined to implement it, which is the whole reason for the iOS
 * branch below.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own mini-infobar and never hands us
    // the event to fire later, so the in-app button would have nothing to do.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    emit();
  });

  // Fired after an install completes by ANY route — our button, the browser's
  // own menu, or the address-bar icon. The saved prompt is spent either way.
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDeferredPrompt(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

/**
 * Fire the saved prompt and report what the person chose.
 *
 * The event is single-use: once fired it cannot be fired again, so it is
 * discarded on ACCEPT only. A dismissal keeps it, because someone who taps
 * "Not now" and then changes their mind a screen later should not have to
 * reload to get the button back.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';

  await event.prompt();
  const { outcome } = await event.userChoice;

  if (outcome === 'accepted') {
    deferredPrompt = null;
    emit();
  }

  return outcome;
}

/**
 * Is the app already running from the home screen?
 *
 * Two checks because the two platforms answer differently: Chromium sets the
 * `display-mode` media feature, and iOS Safari — which has no
 * `beforeinstallprompt` — exposes the non-standard `navigator.standalone`.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayMode = window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
}

/**
 * iOS Safari, where installing is a manual gesture we can only describe.
 *
 * ⚠️ This is the case that makes an install button feel broken if it is not
 * handled. Apple ships no install API at all, and every third-party browser on
 * iOS is WebKit underneath — so Chrome on an iPhone behaves like Safari here,
 * not like Chrome. Drivers on iPhones are a large share of the fleet; showing
 * them nothing, or a button that does nothing, is the worst outcome. They get
 * the Share → Add to Home Screen instructions instead.
 *
 * Matched on the touch-capable Mac too: iPadOS reports itself as "Macintosh"
 * and is otherwise indistinguishable from a desktop by user agent alone.
 */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iosDevice = /iPad|iPhone|iPod/.test(ua);
  const iPadOnDesktopUa = ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
  return iosDevice || iPadOnDesktopUa;
}
