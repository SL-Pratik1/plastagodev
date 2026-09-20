import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '../lib/utils.js';

/**
 * `underline` is the page-level tab set — a rule across the content with the
 * active tab sitting on it. `pill` is a segmented control for tabs NESTED
 * inside a panel that already has an underlined set above it: two underlines
 * stacked read as two competing page sections rather than a whole and its part.
 */
export type TabsVariant = 'underline' | 'pill';

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  baseId: string;
  variant: TabsVariant;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> must be rendered inside <Tabs>`);
  return context;
}

export interface TabsProps {
  /** Controlled value. Omit and pass `defaultValue` for local-only tabs. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** `pill` for a tab set nested inside another tab's panel. */
  variant?: TabsVariant;
  children: ReactNode;
  className?: string;
}

/**
 * ARIA tab pattern, keyboard included.
 *
 * Roving `tabindex` with arrow-key navigation is what the pattern requires and
 * it is the part hand-rolled tabs almost always miss: one Tab press should
 * enter the tab list, then arrows move between tabs, then Tab again lands in
 * the panel — not a walk through eight tab buttons.
 *
 * Prefer the controlled form and keep the active tab in the URL for anything a
 * user might link to or reload. A dropped tab selection on refresh is a small
 * annoyance the tenth time and an obvious rough edge in a demo.
 */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  variant = 'underline',
  children,
  className,
}: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue ?? '');
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  const select = useCallback(
    (next: string) => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const context = useMemo<TabsContextValue>(
    () => ({ value: current, select, baseId, variant }),
    [current, select, baseId, variant],
  );

  return (
    <TabsContext.Provider value={context}>
      <div className={cn('space-y-4', className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export interface TabsListProps extends Omit<ComponentProps<'div'>, 'role'> {
  /** Names the tab set for screen readers, e.g. "Account sections". */
  label: string;
}

export function TabsList({ label, className, children, ...props }: TabsListProps) {
  const { variant } = useTabsContext('TabsList');
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;

    const tabs = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])') ?? [],
    );
    if (tabs.length === 0) return;

    const activeIndex = tabs.findIndex((tab) => tab === document.activeElement);
    let nextIndex = activeIndex;

    if (event.key === 'ArrowRight') nextIndex = (activeIndex + 1) % tabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (activeIndex - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;

    const next = tabs[nextIndex];
    if (!next) return;

    event.preventDefault();
    // Automatic activation: moving focus selects. Correct when panels are cheap;
    // switch to manual (Enter to activate) if a panel ever triggers a slow load.
    next.focus();
    next.click();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'flex gap-1 overflow-x-auto',
        variant === 'underline'
          ? 'border-b border-border'
          : // A tray the selected pill sits inside, so the set reads as one
            // control rather than as four loose buttons.
            'w-fit max-w-full rounded-lg border border-border bg-muted/40 p-1',
        // Scrollable on a phone without a visible scrollbar eating the underline.
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends Omit<ComponentProps<'button'>, 'value'> {
  value: string;
  /** Small count beside the label — queue depth, row totals. */
  badge?: ReactNode;
}

export function TabsTrigger({ value, badge, className, children, ...props }: TabsTriggerProps) {
  const { value: active, select, baseId, variant } = useTabsContext('TabsTrigger');
  const selected = active === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={() => {
        select(value);
      }}
      className={cn(
        'focus-ring flex shrink-0 items-center gap-2 whitespace-nowrap text-sm font-medium transition-colors',
        variant === 'underline'
          ? cn(
              '-mb-px border-b-2 px-3 py-2',
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
            )
          : cn(
              'rounded-md px-3 py-1.5',
              selected
                ? 'bg-card text-foreground shadow-[0_1px_2px_0_rgb(16_24_16/0.06)] dark:bg-accent dark:shadow-none'
                : 'text-muted-foreground hover:text-foreground',
            ),
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      {badge !== undefined && badge !== null && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
            selected ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export interface TabsPanelProps extends ComponentProps<'div'> {
  value: string;
}

export function TabsPanel({ value, className, children, ...props }: TabsPanelProps) {
  const { value: active, baseId } = useTabsContext('TabsPanel');
  if (active !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      // Focusable so Tab out of the tab list lands in the panel, per the pattern.
      tabIndex={0}
      className={cn('focus-ring', className)}
      {...props}
    >
      {children}
    </div>
  );
}
