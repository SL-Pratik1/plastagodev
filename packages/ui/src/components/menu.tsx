import type { LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/utils.js';

export interface MenuProps {
  /** Content of the trigger button — Menu owns the `<button>` itself. */
  trigger: ReactNode;
  /** Required when the trigger has no readable text (an icon-only button). */
  triggerLabel?: string;
  triggerClassName?: string;
  align?: 'start' | 'end';
  children: ReactNode;
  className?: string;
}

/**
 * Dropdown menu — a list of ACTIONS.
 *
 * Not a form control: if the thing being chosen is a value that gets submitted
 * or filtered on, use `Select`, which gets the native picker on a phone. This is
 * for "Edit", "Resend invitation", "Sign out".
 *
 * Positioned with plain absolute layout rather than CSS anchor positioning,
 * which Firefox still does not support. The trade-off is that a menu near the
 * viewport edge does not auto-flip — hence `align="end"` on right-hand triggers.
 */
export function Menu({
  trigger,
  triggerLabel,
  triggerClassName,
  align = 'start',
  children,
  className,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Light dismiss: pointerdown rather than click, so the menu closes before a
  // click on the element underneath resolves.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );

  const focusItem = (index: number) => {
    const all = items();
    if (all.length === 0) return;
    const wrapped = ((index % all.length) + all.length) % all.length;
    all[wrapped]?.focus();
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
      // Focus after the menu paints.
      requestAnimationFrame(() => {
        focusItem(0);
      });
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const activeIndex = all.findIndex((item) => item === document.activeElement);

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(all.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        // Tabbing away from an open menu should close it, not leave it hanging.
        close(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        onClick={() => {
          setOpen((value) => !value);
        }}
        onKeyDown={onTriggerKeyDown}
        className={cn('focus-ring', triggerClassName)}
      >
        {trigger}
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={triggerLabel}
          onKeyDown={onMenuKeyDown}
          onClick={() => {
            // Any item activation closes the menu; items own their own action.
            close(true);
          }}
          className={cn(
            'absolute top-full z-50 mt-1 max-h-[60vh] min-w-52 animate-slide-up overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps {
  onSelect?: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  tone?: 'default' | 'destructive';
  children: ReactNode;
  className?: string;
}

export function MenuItem({
  onSelect,
  icon: Icon,
  disabled = false,
  tone = 'default',
  children,
  className,
}: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect?.();
      }}
      className={cn(
        'focus-ring flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
        tone === 'destructive'
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-accent hover:text-accent-foreground',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <div aria-hidden className="my-1 h-px bg-border" />;
}
