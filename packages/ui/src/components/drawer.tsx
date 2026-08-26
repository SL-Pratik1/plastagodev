import { XIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `left` for navigation, `right` for detail and filters. */
  side?: 'left' | 'right';
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

const SIZE = {
  sm: 'sm:max-w-xs',
  default: 'sm:max-w-sm',
  lg: 'sm:max-w-md',
} as const;

/**
 * Edge-anchored panel, on the same native `<dialog>` foundation as Dialog — so
 * it inherits the same focus trap, top layer and Escape handling.
 *
 * Used for two things in this console: the navigation menu below `lg`, and
 * filter or detail panels that would otherwise push a grid off screen. Anything
 * that needs the user's full attention belongs in a Dialog instead; a drawer
 * reads as "alongside", a dialog reads as "instead of".
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  side = 'right',
  size = 'default',
  className,
}: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-0 h-dvh max-h-none w-[85vw] max-w-none border-border bg-card p-0 text-card-foreground shadow-2xl',
        'backdrop:bg-brand-900/50 backdrop:backdrop-blur-[2px] backdrop:open:animate-fade-in',
        side === 'right'
          ? 'ml-auto border-l open:animate-slide-in-right'
          : 'mr-auto border-r open:animate-slide-in-left',
        SIZE[size],
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start gap-4 border-b border-border p-4">
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
          <button
            type="button"
            onClick={onClose}
            className="focus-ring -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden className="size-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

        {footer && <div className="border-t border-border p-4">{footer}</div>}
      </div>
    </dialog>
  );
}
