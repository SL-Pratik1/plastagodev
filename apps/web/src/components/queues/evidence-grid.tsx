import type { JobPhoto } from '@plastago/shared';
import { EmptyState } from '@plastago/ui';
import { ImageIcon, MapPinIcon } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { useStaleUrlRefresh } from '@/lib/use-stale-url-refresh';

/**
 * The photos a driver attached, shown where the decision is made.
 *
 * ── Why this is not a link to the job ─────────────────────────────────────
 * M2.7's argument is that the office opens the queue, *sees the photo of the
 * timber offcuts in the bag*, and approves. Making them open the job in another
 * tab to look is how a 10-second decision becomes a 2-minute one, and a
 * 2-minute decision is one that gets deferred — which is how charges end up
 * weeks old and unapproved today.
 *
 * ── The photograph, and what sits under it ────────────────────────────────
 * The tile carries the caption, the capture time and the GPS fix as well as the
 * image, because those three facts are what make the evidence defensible when a
 * builder disputes the charge. They are shown whether or not the image loads.
 *
 * ⚠️ This grid rendered no photograph at all until `JobPhoto.url` existed: the
 * API had the bytes in a private bucket and no field to hand back a signed URL
 * in, so every approver saw a grey icon on a charge they were about to make
 * billable. If `url` is ever null here again, suspect the projection before the
 * component — see `toJobPhotoViews` on the API side.
 */

/**
 * One tile's photograph, and what to show when there is not one.
 *
 * ── Why the failure state is not a broken image ───────────────────────────
 * The URL is signed with a short expiry, so a dialog left open long enough will
 * eventually be holding a dead link. The browser's own broken-image glyph on an
 * evidence grid reads as "the photo is lost"; a labelled placeholder says the
 * truer thing, which is that the picture could not be fetched right now while
 * the caption, time and position underneath it are still perfectly good.
 *
 * ── Why it opens full size ────────────────────────────────────────────────
 * A 4:3 thumbnail three to a row is enough to see THAT there is timber in the
 * bag and not enough to judge how much, which is the thing the charge turns on.
 */
function EvidenceImage({
  photo,
  onStale,
}: {
  photo: JobPhoto;
  /** Ask the screen for freshly signed URLs — see `useStaleUrlRefresh`. */
  onStale?: (() => void) | undefined;
}) {
  /*
   * ⚠️ `failed` must not outlive the URL that failed.
   *
   * It latches by design — an `onError` that cleared itself would loop — so a
   * tile that fails once would stay a placeholder for the life of the component,
   * including after a refetch handed it a perfectly good new URL.
   *
   * The reset is done by KEYING this component on the URL where it is rendered,
   * so a new URL mounts a new component with a fresh flag. That is React's own
   * answer to "reset state when a prop changes", and it avoids the cascading
   * render an effect calling `setState` would cause.
   */
  const [failed, setFailed] = useState(false);

  if (photo.url === null || failed) {
    return (
      <div className="grid aspect-4/3 place-items-center bg-muted text-muted-foreground">
        <ImageIcon aria-hidden className="size-6" />
        <span className="sr-only">
          {failed
            ? `Photograph could not be loaded: ${photo.caption}`
            : `Photograph not available: ${photo.caption}`}
        </span>
      </div>
    );
  }

  return (
    <a
      href={photo.url}
      target="_blank"
      rel="noreferrer"
      className="focus-ring block aspect-4/3 overflow-hidden bg-muted"
    >
      <img
        src={photo.url}
        alt={`Photograph: ${photo.caption}`}
        loading="lazy"
        className="size-full object-cover transition-transform hover:scale-105"
        onError={() => {
          setFailed(true);
          /*
           * Almost always an expired signature: this grid sits in a job tab or
           * a dialog that stays open well past the fifteen minutes a link is
           * signed for. A fresh read of the record signs new links, and the key
           * on this component resets the tile when one arrives. Without it the
           * tile stayed a placeholder until a full page reload.
           */
          onStale?.();
        }}
      />
    </a>
  );
}

export function EvidenceGrid({
  photos,
  onStale,
}: {
  photos: readonly JobPhoto[];
  /**
   * Refetch the record the photos came from, so they arrive with freshly
   * signed URLs. Capped to once a minute however many tiles fail.
   */
  onStale?: (() => unknown) | undefined;
}) {
  const requestFreshUrls = useStaleUrlRefresh(onStale);

  if (photos.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title="No photos attached"
        description="The driver raised this without evidence. Worth a call before approving."
      />
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {photos.map((photo) => (
        <li key={photo.id} className="overflow-hidden rounded-lg border border-border bg-muted/40">
          <EvidenceImage key={photo.url ?? photo.id} photo={photo} onStale={requestFreshUrls} />
          <div className="space-y-0.5 p-2">
            <p className="truncate text-xs font-medium">{photo.caption}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {formatTime(photo.takenAt)} · {photo.takenBy}
            </p>
            {photo.latitude !== null && photo.longitude !== null && (
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <MapPinIcon aria-hidden className="size-3 shrink-0" />
                <span className="tabular-nums">
                  {photo.latitude.toFixed(4)}, {photo.longitude.toFixed(4)}
                </span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
