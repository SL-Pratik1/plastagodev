import { useEffect, useState, type RefObject } from 'react';

/**
 * The element a portalled popup (a Radix select list, a popover) must render
 * into so it is visible from inside a modal `Dialog`.
 *
 * ── Why this is needed at all ─────────────────────────────────────────────
 * `Dialog` is the native `<dialog>` element opened with `showModal()`, which
 * promotes it to the browser's TOP LAYER — painted above everything in the
 * normal document, and with the rest of the page inert. Radix portals default
 * to `document.body`, which is the normal document. So a select opened inside
 * a dialog rendered its list *behind* the dialog's own card: no z-index helps,
 * because the top layer is above the entire stacking context, and the list was
 * unclickable for the same reason the background page is.
 *
 * The symptom read as data missing rather than a layering fault — the role
 * picker on "Invite a user" looked like it only offered some of the roles.
 *
 * Returning the nearest ancestor `<dialog>` puts the popup in the top layer
 * alongside the dialog. `undefined` outside a dialog leaves Radix on its
 * `document.body` default.
 *
 * The lookup is by DOM ancestry rather than "whichever dialog is open", so it
 * is correct before the dialog is opened and for nested dialogs both.
 */
export function usePortalContainer(ref: RefObject<Element | null>): HTMLElement | undefined {
  const [container, setContainer] = useState<HTMLDialogElement>();

  // Runs after the ref is attached; a popup cannot be open before that.
  useEffect(() => {
    setContainer(ref.current?.closest('dialog') ?? undefined);
  }, [ref]);

  return container;
}
