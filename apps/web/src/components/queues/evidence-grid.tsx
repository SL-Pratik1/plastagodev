import type { JobPhoto } from '@plastago/shared';
import { EmptyState } from '@plastago/ui';
import { ImageIcon, MapPinIcon } from 'lucide-react';
import { formatTime } from '@/lib/format';

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
 * ⚠️ There are no image files in the demo build, so each tile renders its
 * caption, capture time and GPS fix instead of a photograph. That is deliberate
 * rather than a placeholder: those three facts are what make the evidence
 * defensible when a builder disputes the charge, and they are exactly what the
 * real tile will carry underneath the image.
 */
export function EvidenceGrid({ photos }: { photos: readonly JobPhoto[] }) {
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
          <div className="grid aspect-4/3 place-items-center bg-muted text-muted-foreground">
            <ImageIcon aria-hidden className="size-6" />
            <span className="sr-only">Photograph: {photo.caption}</span>
          </div>
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
