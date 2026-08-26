import { useEffect } from 'react';

/**
 * Warns before the browser discards unsaved edits.
 *
 * ── What this can and cannot do ────────────────────────────────────────────
 * `beforeunload` covers closing the tab, reloading, and following a link out of
 * the app — the cases where the browser is about to throw the work away and
 * nothing in React can stop it. The wording is the browser's own; a custom
 * message has been ignored by every major browser for years, so the string here
 * exists only to satisfy the older API shape.
 *
 * It deliberately does NOT try to intercept in-app navigation. A router-level
 * block that fires on every click is worse than the problem: people learn to
 * dismiss it, and it can strand someone on a form they cannot leave. Screens
 * pair this with a visible unsaved-changes bar instead, which is honest about
 * the state and offers Save and Discard rather than a modal that only says "are
 * you sure".
 */
export function useUnsavedChanges(isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Required by the legacy contract; the text is never shown.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [isDirty]);
}
