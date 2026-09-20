import type { DriverPhoto, RequiredPhoto } from '@plastago/shared';
import { Badge, Button, cn } from '@plastago/ui';
import { CameraIcon, CheckIcon, CloudUploadIcon, ImageIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * The required-photo checklist and what has been taken (M4.5).
 *
 * ── Prompts, not just a camera button ─────────────────────────────────────
 * Matt asked for *"a prompt of what's in the photos that are required, and a
 * space to put in any others"*, and the reason is commercial: the standard set —
 * front of site, pile before, pile after, site closed, and cars on site if it
 * could not be closed — is the evidence that defends their charges. A driver who
 * takes ten photos of the wrong things has taken none.
 *
 * ── Upload state is per photo, not per job ────────────────────────────────
 * A driver can be halfway through a run with four photos synced and six queued.
 * A single job-level "syncing" badge would hide which ones are still only on the
 * phone — and on a phone that is the difference between evidence and nothing.
 */
/**
 * One taken photo, as a thumbnail you can actually look at.
 *
 * ── Why the image matters more than the timestamp ─────────────────────────
 * This row used to be a time chip and a delete button — the driver was told a
 * photo existed and shown nothing. On a checklist whose whole purpose is
 * evidence, a driver cannot tell a good "pile before" from a thumb over the
 * lens without seeing it, and the office approves the charge "by looking at the
 * picture" long after the truck has left. The one chance to notice a useless
 * shot is while still standing on the site.
 *
 * ── The three states, and why none of them is a spinner ───────────────────
 * Sending (no URL yet), visible, and broken. A photo still in the outbox has no
 * signed URL because the object is not there — it shows the cloud icon rather
 * than a placeholder that would imply something is wrong. `onError` covers the
 * narrow case of a URL that expired while the screen sat open: the tile falls
 * back to an icon instead of the browser's broken-image glyph.
 */
function PhotoThumb({
  photo,
  label,
  onRemove,
}: {
  photo: DriverPhoto;
  label: string;
  onRemove: () => void;
}) {
  const [failed, setFailed] = useState(false);

  const takenAt = new Date(photo.takenAt).toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return (
    <div className="relative">
      <a
        href={photo.url ?? undefined}
        target="_blank"
        rel="noreferrer"
        // Not a link at all until there is something to open: a dead anchor
        // that does nothing when tapped reads as the app being broken.
        aria-disabled={photo.url === null}
        className={cn(
          'focus-ring block size-20 overflow-hidden rounded-lg border border-border bg-muted',
          photo.url === null && 'pointer-events-none',
        )}
      >
        {photo.url !== null && !failed ? (
          <img
            src={photo.url}
            alt={`${label}, taken at ${takenAt}`}
            loading="lazy"
            className="size-full object-cover"
            onError={() => {
              setFailed(true);
            }}
          />
        ) : (
          <span className="grid size-full place-items-center text-muted-foreground">
            {photo.uploaded ? (
              <ImageIcon aria-hidden className="size-5" />
            ) : (
              <CloudUploadIcon aria-hidden className="size-5 text-warning" />
            )}
          </span>
        )}
      </a>

      {/*
        Over the image rather than beside it — six thumbnails on a phone is
        already the full width, and the time is context, not a column.
      */}
      <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/60 px-1 py-0.5 text-[10px] text-white">
        {photo.uploaded ? (
          <CheckIcon aria-hidden className="size-2.5 text-success" />
        ) : (
          <CloudUploadIcon aria-hidden className="size-2.5 text-warning" />
        )}
        <span className="tabular-nums">{takenAt}</span>
      </span>

      <button
        type="button"
        aria-label={`Remove the ${label.toLowerCase()} photo taken at ${takenAt}`}
        // 44px of tappable area on a 20px glyph: this sits on a screen used in
        // gloves, and a mis-tap deletes evidence.
        className="focus-ring absolute -top-1.5 -right-1.5 grid size-6 place-items-center rounded-full border border-border bg-card text-muted-foreground shadow-sm hover:text-destructive"
        onClick={onRemove}
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}

export interface PhotoGridProps {
  photos: readonly DriverPhoto[];
  required: readonly RequiredPhoto[];
  onCapture: (slot: string | null, caption: string) => void;
  onRemove: (photoId: string) => void;
  busySlot?: string | null;
  disabled?: boolean;
}

export function PhotoGrid({
  photos,
  required,
  onCapture,
  onRemove,
  busySlot,
  disabled = false,
}: PhotoGridProps) {
  const extras = photos.filter((photo) => photo.slot === null);

  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {required.map((slot) => {
          const taken = photos.filter((photo) => photo.slot === slot.key);
          const done = taken.length > 0;

          return (
            <li
              key={slot.key}
              className={cn(
                'rounded-xl border p-3',
                done ? 'border-success/40 bg-success/5' : 'border-border',
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full',
                    done ? 'bg-success text-success-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {done ? <CheckIcon className="size-3.5" /> : <ImageIcon className="size-3.5" />}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-tight font-medium">
                    {slot.label}
                    {!slot.required && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        only if needed
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{slot.hint}</p>

                  {taken.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {taken.map((photo) => (
                        <li key={photo.id}>
                          <PhotoThumb
                            photo={photo}
                            label={slot.label}
                            onRemove={() => {
                              onRemove(photo.id);
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Button
                  size="sm"
                  variant={done ? 'outline' : 'default'}
                  className="min-h-11 shrink-0"
                  disabled={disabled || busySlot === slot.key}
                  onClick={() => {
                    onCapture(slot.key, slot.label);
                  }}
                >
                  <CameraIcon aria-hidden />
                  {done ? 'Another' : 'Take'}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="rounded-xl border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Anything else</p>
            <p className="text-xs text-muted-foreground">
              Damage, access problems, whatever you want on the record. No limit.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 shrink-0"
            disabled={disabled || busySlot === 'extra'}
            onClick={() => {
              onCapture(null, 'Extra photo');
            }}
          >
            <CameraIcon aria-hidden />
            Take
          </Button>
        </div>

        {extras.length > 0 && (
          <div className="mt-3 space-y-2">
            <Badge variant="secondary">
              {extras.length} extra photo{extras.length === 1 ? '' : 's'}
            </Badge>
            <ul className="flex flex-wrap gap-2">
              {extras.map((photo) => (
                <li key={photo.id}>
                  <PhotoThumb
                    photo={photo}
                    label={photo.caption}
                    onRemove={() => {
                      onRemove(photo.id);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
