import type { InvoiceDownload, InvoiceDownloads } from '@plastago/shared';
import { Button, Dialog } from '@plastago/ui';
import { DownloadIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * M7.6 — putting a rendered invoice in front of the person who asked for it.
 *
 * ── Why this is a hook and not three lines in each page ───────────────────
 * Two screens need it — the office's invoice list and detail page, and the
 * customer's portal — and both have the same two awkward problems: a popup
 * blocker, and a bulk request that produces many files at once.
 *
 * ── The reserved tab ──────────────────────────────────────────────────────
 * ⚠️ `window.open` is only permitted DURING a user gesture. The URL does not
 * exist yet at that moment — it comes back from the render a second later — so
 * opening the tab after `await` is exactly the call a browser silently blocks,
 * and the button would appear to do nothing. `begin()` is therefore called
 * synchronously in the click handler to reserve a blank tab, and the URL is
 * pointed at it once it arrives.
 *
 * ── Why several files get a dialog instead of several tabs ────────────────
 * Because no browser will open forty. A list of real links is also the honest
 * answer to a partial render: the office can see WHICH invoices produced a
 * document, rather than being told forty were queued when thirty-nine were.
 */

export interface InvoiceDownloadsController {
  /**
   * Call this synchronously inside the click handler, before any `await`.
   *
   * Returns the function that delivers the result once the request resolves.
   */
  begin: () => (result: InvoiceDownloads) => DeliverySummary;
  /** Render this somewhere in the page. */
  dialog: ReactNode;
}

export interface DeliverySummary {
  delivered: number;
  /** Asked for but not produced — a brand with no invoice template, usually. */
  failed: number;
}

export function useInvoiceDownloads(): InvoiceDownloadsController {
  const [listed, setListed] = useState<readonly InvoiceDownload[] | null>(null);

  const begin = () => {
    /*
     * Reserved now, while the click is still the reason anything is happening.
     * `null` where the browser refused even this — the dialog below is then the
     * fallback, so a blocked popup degrades to a link rather than to silence.
     *
     * ⚠️ Deliberately WITHOUT `noopener`. That feature makes `window.open`
     * return null by specification, and the handle is the entire point here —
     * asking for it and discarding it would send every single download to the
     * dialog. The opener is severed below instead, which is the same protection
     * arrived at the other way round.
     */
    const reserved = window.open('', '_blank');

    return (result: InvoiceDownloads): DeliverySummary => {
      const { downloads, requested } = result;
      const summary = { delivered: downloads.length, failed: requested - downloads.length };

      /*
       * Read out rather than indexed twice: the length check does not narrow
       * the element type, and asserting it away would be a claim the compiler
       * has already declined to make.
       */
      const only = downloads.length === 1 ? downloads[0] : undefined;

      if (only && reserved) {
        /*
         * Severed BEFORE navigating, while the blank tab is still same-origin
         * and writable. Afterwards it is a cross-origin document and this
         * assignment throws.
         */
        reserved.opener = null;
        reserved.location.href = only.url;
        return summary;
      }

      // Nothing to show it, or too many to show this way.
      reserved?.close();
      if (downloads.length > 0) setListed(downloads);

      return summary;
    };
  };

  const dialog = (
    <Dialog
      open={listed !== null}
      onClose={() => {
        setListed(null);
      }}
      title="Invoices ready"
      description="Each one opens in a new tab. They are links to the stored document, not a fresh rendering of it."
      footer={
        <Button
          variant="outline"
          onClick={() => {
            setListed(null);
          }}
        >
          Done
        </Button>
      }
    >
      <ul className="divide-y divide-border">
        {(listed ?? []).map((download) => (
          <li key={download.id} className="py-2">
            {/*
              A real anchor the person clicks themselves. Every alternative —
              opening them in a loop, triggering synthetic clicks — is a popup
              blocker away from doing nothing at all.
            */}
            <a
              href={download.url}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring flex items-center gap-2 rounded text-sm text-primary underline underline-offset-4"
            >
              <DownloadIcon className="size-4 shrink-0" aria-hidden />
              {download.fileName}
            </a>
          </li>
        ))}
      </ul>
    </Dialog>
  );

  return { begin, dialog };
}
