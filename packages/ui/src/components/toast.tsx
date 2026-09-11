import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../lib/utils.js';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** One line, past tense, specific: "Invitation sent to Dave Nguyen". */
  title: string;
  description?: ReactNode;
  variant?: ToastVariant;
  /** Milliseconds. `0` keeps it until dismissed — the default for errors. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastRecord extends ToastOptions {
  id: number;
  variant: ToastVariant;
  duration: number;
}

export interface ToastApi {
  toast: (options: ToastOptions) => number;
  success: (title: string, description?: ReactNode) => number;
  error: (title: string, description?: ReactNode) => number;
  warning: (title: string, description?: ReactNode) => number;
  info: (title: string, description?: ReactNode) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Transient confirmation of something that happened out of view.
 *
 * When NOT to reach for this: if the result is already visible on screen — the
 * row disappeared, the badge changed, the value updated — a toast is noise.
 * Toasts are for the invisible half: the email that went out, the record that
 * saved and scrolled away, the thing that failed while the user looked
 * elsewhere.
 *
 * Two defaults worth knowing:
 *  • Errors do not auto-dismiss. A failure the user missed is a failure they
 *    will hit again, and with no error tracking on this project (§6A.8) the
 *    toast may be the only record anyone sees.
 *  • Hovering or focusing a toast pauses its timer, so a long description is
 *    actually readable.
 */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 0,
};

/** Beyond this, older toasts are dropped — a wall of toasts communicates nothing. */
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const variant = options.variant ?? 'info';
    const id = nextId.current;
    nextId.current += 1;

    setToasts((current) =>
      [
        ...current,
        { ...options, id, variant, duration: options.duration ?? DEFAULT_DURATION[variant] },
      ].slice(-MAX_VISIBLE),
    );

    return id;
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ title, description, variant: 'success' }),
      error: (title, description) => toast({ title, description, variant: 'error' }),
      warning: (title, description) => toast({ title, description, variant: 'warning' }),
      info: (title, description) => toast({ title, description, variant: 'info' }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

const VARIANT_ICON = {
  success: CircleCheckIcon,
  error: CircleAlertIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
} as const;

const VARIANT_STYLE: Record<ToastVariant, string> = {
  success: 'border-success/35 [&_[data-toast-icon]]:text-success',
  error: 'border-destructive/40 [&_[data-toast-icon]]:text-destructive',
  warning: 'border-warning/40 [&_[data-toast-icon]]:text-warning',
  info: 'border-info/35 [&_[data-toast-icon]]:text-info',
};

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastRecord[];
  onDismiss: (id: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const showing = toasts.length > 0;

  /*
   * ⚠️ Promoted to the top layer, and re-promoted on every arrival.
   *
   * A modal <dialog> lives in the browser's TOP LAYER, above every z-index
   * there is, so a plain fixed viewport puts its toasts BEHIND any open dialog
   * — and a dialog is where most of them are raised. Pressing a failing "Create
   * account" therefore looked like it did nothing at all.
   *
   * The top layer stacks in promotion order, so hiding and re-showing as each
   * toast arrives is what keeps the bar above a dialog that opened after this
   * provider mounted. Positioning lives in `theme.css` under
   * `[data-toast-viewport]`, because the UA stylesheet for [popover] sets six
   * properties that utilities would have to beat one at a time.
   *
   * Guarded: `showPopover` throws when the element is already open or not yet
   * connected, and neither is worth taking a screen down for.
   */
  useEffect(() => {
    const node = element.current;
    if (!node) return;

    try {
      if (showing) {
        if (node.matches(':popover-open')) node.hidePopover();
        node.showPopover();
      } else if (node.matches(':popover-open')) {
        node.hidePopover();
      }
    } catch {
      // An engine without the popover API. The toasts still render, and the
      // stylesheet leaves them where they have always been.
    }
  }, [showing, toasts]);

  return (
    <div
      ref={element}
      popover="manual"
      data-toast-viewport=""
      // The live region wraps the viewport, not each toast, so it exists in the
      // DOM before the first toast arrives — a region created at the same moment
      // as its content is frequently not announced.
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((item) => (
        <ToastItem key={item.id} toast={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastRecord; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = VARIANT_ICON[toast.variant];

  useEffect(() => {
    if (toast.duration === 0 || paused) return;

    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration);

    return () => {
      clearTimeout(timer);
    };
  }, [toast.duration, toast.id, paused, onDismiss]);

  return (
    <div
      // Errors interrupt; everything else waits its turn.
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={() => {
        setPaused(false);
      }}
      className={cn(
        'pointer-events-auto flex w-full max-w-sm animate-slide-up gap-3 rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-lg',
        VARIANT_STYLE[toast.variant],
      )}
    >
      <Icon aria-hidden data-toast-icon className="mt-0.5 size-4 shrink-0" />

      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description !== undefined && toast.description !== null && (
          <p className="text-sm text-muted-foreground">{toast.description}</p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="focus-ring rounded text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          onDismiss(toast.id);
        }}
        className="focus-ring -mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <XIcon aria-hidden className="size-3.5" />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  );
}
