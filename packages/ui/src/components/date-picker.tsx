import { CalendarIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { Calendar } from './calendar.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { usePortalContainer } from '../lib/portal-container.js';
import { cn } from '../lib/utils.js';

/**
 * DatePicker — a themed calendar over a real `<input type="date">`.
 *
 * The same arrangement as `Select`, for the same reasons. The visible control is
 * ours, so the drop-down is the console's calendar rather than Chrome's blue
 * grid with its system-blue "Clear"/"Today" links. Underneath, a hidden native
 * date input stays the source of truth: it is what `register('readyDate')`
 * attaches its ref to, what carries `name` into a submission, and what fires the
 * `change` event that call sites' `onChange` handlers already read.
 *
 * The API matches the `Input type="date"` it replaces — an ISO `yyyy-mm-dd`
 * string in `value`, `event.target.value` out — so screens did not have to
 * change. `min`/`max` are honoured as disabled days in the calendar as well as
 * on the native element.
 */

/** Display format. Fixed to en-AU so it never follows the viewer's OS locale. */
const DISPLAY = new Intl.DateTimeFormat('en-AU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/**
 * Parses `yyyy-mm-dd` into a LOCAL date.
 *
 * `new Date('2026-08-26')` is specified to parse as UTC midnight, which in any
 * negative-offset timezone renders as the 25th. Building from parts keeps the
 * calendar's highlighted day equal to the stored day everywhere.
 */
function parseIso(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The inverse of `parseIso`, avoiding `toISOString()`'s UTC shift. */
function toIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export interface DatePickerProps
  extends Omit<ComponentProps<'input'>, 'onChange' | 'type' | 'value' | 'size'> {
  value?: string;
  onChange?: ComponentProps<'input'>['onChange'];
  /** Fired with the raw ISO string, for code that does not want an event. */
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function DatePicker({
  className,
  value,
  defaultValue,
  onChange,
  onValueChange,
  disabled,
  required,
  name,
  form,
  min,
  max,
  id,
  ref,
  onBlur,
  placeholder = 'Choose a date',
  ...triggerProps
}: DatePickerProps) {
  const nativeRef = useRef<HTMLInputElement>(null);
  const fallbackId = useId();
  const triggerId = id ?? fallbackId;
  const [open, setOpen] = useState(false);
  // A calendar opened inside a modal `Dialog` has to join it in the top layer.
  const portalContainer = usePortalContainer(nativeRef);

  // Stable ref, and kept current in an effect — see the note in `select.tsx`:
  // an inline ref callback detaches and reattaches every render, which stops
  // react-hook-form from populating the field from `defaultValues`.
  // A later ref is also HANDED the element, because a stable callback is only
  // ever called once per node — see the long note in `select.tsx`. Without it,
  // react-hook-form's `reset()` leaves the field holding its `{ name }`
  // placeholder and every date picked afterwards is stored as `undefined`.
  const forwardedRef = useRef(ref);
  useEffect(() => {
    forwardedRef.current = ref;
    const node = nativeRef.current;
    if (!node) return;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const attachRef = useCallback((node: HTMLInputElement | null) => {
    nativeRef.current = node;
    const target = forwardedRef.current;
    if (typeof target === 'function') target(node);
    else if (target) target.current = node;
  }, []);

  const isControlled = value !== undefined;
  const [mirrored, setMirrored] = useState(() => String(defaultValue ?? ''));

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const native = nativeRef.current;
    if (!native || isControlled) return;
    setMirrored((current) => (current === native.value ? current : native.value));
  });

  const current = isControlled ? String(value) : mirrored;
  const selected = parseIso(current);

  const commit = (next: string) => {
    const native = nativeRef.current;

    if (native) {
      // Assign through the prototype setter so React's value tracker sees the
      // change and does not swallow the event that follows.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) Reflect.apply(setter, native, [next]);
      // What a browser fires for a date field, in order. React's tracker
      // collapses the pair into a single `onChange`.
      native.dispatchEvent(new Event('input', { bubbles: true }));
      native.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (!isControlled) setMirrored(next);
    onValueChange?.(next);
  };

  const minDate = typeof min === 'string' ? parseIso(min) : undefined;
  const maxDate = typeof max === 'string' ? parseIso(max) : undefined;

  // Built as a list so a field with only `min` (the common case — "not in the
  // past") does not also pass an `after: undefined` matcher.
  const outOfRange = [
    ...(minDate ? [{ before: minDate }] : []),
    ...(maxDate ? [{ after: maxDate }] : []),
  ];

  return (
    <>
      <input
        ref={attachRef}
        type="date"
        name={name}
        form={form}
        required={required}
        disabled={disabled}
        min={min}
        max={max}
        onChange={onChange}
        onBlur={onBlur}
        {...(isControlled ? { value } : { defaultValue })}
        aria-hidden
        tabIndex={-1}
        className="sr-only"
      />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={triggerId}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-background py-1 pr-2.5 pl-3 text-sm shadow-xs transition-colors',
            'hover:border-ring/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/30',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
            className,
          )}
          {...(triggerProps as ComponentProps<typeof PopoverTrigger>)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? DISPLAY.format(selected) : placeholder}
          </span>
          <CalendarIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>

        <PopoverContent className="w-auto" container={portalContainer}>
          <Calendar
            mode="single"
            autoFocus
            selected={selected}
            defaultMonth={selected}
            startMonth={minDate}
            endMonth={maxDate}
            disabled={outOfRange.length > 0 ? outOfRange : undefined}
            onSelect={(date) => {
              // Radix keeps the popover open on re-render; close it ourselves so
              // choosing a day feels like completing the interaction.
              commit(date ? toIso(date) : '');
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
