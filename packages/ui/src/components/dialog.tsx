import { XIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/utils.js';

/**
 * Modal dialog built on the native `<dialog>` element.
 *
 * `showModal()` gives us, from the platform and for free: focus trapping, a
 * top-layer stacking context that cannot be clipped by an ancestor's
 * `overflow: hidden`, inert background content, Escape handling, and correct
 * `aria-modal` semantics. Hand-rolled modals reimplement all of that and
 * usually miss the focus trap — which is exactly the part a keyboard user
 * needs. This is why no dialog dependency was added.
 *
 * React stays the source of truth: the native `cancel` event is prevented and
 * turned into an `onClose()` call, so the element's `open` attribute can never
 * drift out of sync with the `open` prop.
 */

/** Background scroll lock, refcounted so nested dialogs cannot unlock early. */
let openDialogCount = 0;

function lockBodyScroll(): () => void {
  openDialogCount += 1;
  const { body } = document;
  const previous = body.style.overflow;
  if (openDialogCount === 1) body.style.overflow = 'hidden';

  return () => {
    openDialogCount -= 1;
    if (openDialogCount === 0) body.style.overflow = previous;
  };
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Action row. Rendered right-aligned on desktop, stacked full-width on phones. */
  footer?: ReactNode;
  size?: 'sm' | 'default' | 'lg';
  /**
   * `false` removes the close button and ignores Escape and backdrop clicks —
   * for a step that must be completed or explicitly cancelled. Use sparingly:
   * a dialog with no visible way out is a trap.
   */
  dismissible?: boolean;
  className?: string;
}

const SIZE = {
  sm: 'sm:max-w-sm',
  default: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
} as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'default',
  dismissible = true,
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return lockBodyScroll();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Always prevent: letting the browser close it would leave `open` true.
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        // The dialog box is a child, so a click landing on the element itself
        // is a click on the backdrop.
        if (dismissible && event.target === ref.current) onClose();
      }}
      className={cn(
        'group m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-visible rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl',
        'backdrop:bg-brand-900/50 backdrop:backdrop-blur-[2px]',
        'open:animate-zoom-in backdrop:open:animate-fade-in',
        SIZE[size],
        className,
      )}
    >
      {/* Inner wrapper: the click-outside check above needs a child to hit. */}
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="flex items-start gap-4 p-5 pb-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 id={titleId} className="text-base font-semibold tracking-tight">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>

          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              className="focus-ring -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon aria-hidden className="size-4" />
              <span className="sr-only">Close</span>
            </button>
          )}
        </div>

        {children !== undefined && children !== null && (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-1 text-sm">{children}</div>
        )}

        {footer && (
          <div className="flex flex-col-reverse gap-2 p-5 pt-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}
