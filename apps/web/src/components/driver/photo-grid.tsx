import type { DriverPhoto, RequiredPhoto } from '@plastago/shared';
import { Badge, Button, cn } from '@plastago/ui';
import { CameraIcon, CheckIcon, CloudUploadIcon, ImageIcon, XIcon } from 'lucide-react';

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
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {taken.map((photo) => (
                        <li key={photo.id}>
                          <span className="flex items-center gap-1 rounded-full bg-card px-2 py-1 text-[11px]">
                            {photo.uploaded ? (
                              <CheckIcon aria-hidden className="size-3 text-success" />
                            ) : (
                              <CloudUploadIcon aria-hidden className="size-3 text-warning" />
                            )}
                            <span className="tabular-nums">
                              {new Date(photo.takenAt).toLocaleTimeString('en-AU', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                              })}
                            </span>
                            <button
                              type="button"
                              aria-label={`Remove the ${slot.label.toLowerCase()} photo`}
                              className="focus-ring rounded-full text-muted-foreground hover:text-destructive"
                              onClick={() => {
                                onRemove(photo.id);
                              }}
                            >
                              <XIcon aria-hidden className="size-3" />
                            </button>
                          </span>
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
          <p className="mt-2">
            <Badge variant="secondary">
              {extras.length} extra photo{extras.length === 1 ? '' : 's'}
            </Badge>
          </p>
        )}
      </div>
    </div>
  );
}
