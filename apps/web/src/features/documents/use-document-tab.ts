/**
 * Opening ONE generated document in a new tab.
 *
 * ── Why a reserved tab, and not just `window.open(url)` ───────────────────
 * ⚠️ `window.open` is only permitted DURING a user gesture. The URL does not
 * exist at that moment — it is a signed link the server mints a moment later —
 * so opening the tab after the `await` is exactly the call a browser silently
 * blocks, and the button appears to do nothing at all.
 *
 * So the tab is reserved synchronously inside the click handler, and pointed
 * at the URL once it arrives. This is the same arrangement
 * `useInvoiceDownloads` makes for invoices; this is the single-document case,
 * without the bulk dialog that one needs.
 *
 * Usage, with `begin()` called before any `await`:
 *
 *   const openTab = useDocumentTab();
 *   const deliver = openTab();
 *   const { url } = await requestPdf.mutateAsync(id);
 *   deliver(url);
 */

export type DeliverDocument = (url: string) => void;

export function useDocumentTab(): () => DeliverDocument {
  return () => {
    /*
     * ⚠️ Deliberately WITHOUT `noopener`. That feature makes `window.open`
     * return null by specification, and the handle is the entire point here.
     * The opener is severed below instead, which is the same protection
     * arrived at the other way round.
     *
     * `null` where the browser refused even this — the caller then falls back
     * to navigating the current tab, which always works.
     */
    const reserved = window.open('', '_blank');

    return (url: string) => {
      if (!reserved) {
        // A blocked popup degrades to navigating here rather than to silence.
        window.location.href = url;
        return;
      }

      /*
       * Severed BEFORE navigating, while the blank tab is still same-origin
       * and writable. Afterwards it is a cross-origin document and this
       * assignment throws.
       */
      reserved.opener = null;
      reserved.location.href = url;
    };
  };
}
