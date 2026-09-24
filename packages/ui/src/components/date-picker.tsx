import { CalendarIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
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

/** `DD/MM/YYYY` — the same order the field accepts typed input in. */
function formatForInput(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${String(date.getFullYear())}`;
}

/**
 * Turns whatever was typed into a `DD/MM/YYYY` draft, digits-only.
 *
 * Deliberately loose while typing — it only extracts digits and re-inserts
 * the slashes, so pasting `20032027` and typing `20/03/2027` land on the same
 * draft, and backspacing at the end removes one digit rather than fighting a
 * cursor position the mask just changed.
 */
function maskDraft(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join('/');
}

/** A complete, real calendar date, or `undefined` — never a "close enough" one. */
function parseTyped(text: string): Date | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return undefined;
  const [, dd, mm, yyyy] = match;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const date = new Date(year, month - 1, day);
  // `new Date(2027, 1, 31)` rolls over to March 3rd rather than throwing —
  // this is what actually rejects `31/02/2027`.
  const isRealDate =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return isRealDate ? date : undefined;
}

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

  // Non-null while the person is actively typing over the field. `null` means
  // "show whatever `selected` resolves to" — the moment a keystroke lands this
  // takes over, and it is cleared again once that keystroke's text is either
  // committed or rejected, so a stale draft can never survive past one edit.
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? (selected ? formatForInput(selected) : '');

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

  /**
   * Turns whatever is sitting in `draft` into a commit, or discards it.
   *
   * Runs on blur and on Enter. A date outside `min`/`max` is treated the same
   * as an unparsable one — rejected, not clamped — because silently moving
   * what somebody typed to the nearest allowed day is its own kind of wrong
   * answer. Either way `draft` is cleared afterwards: a rejected edit reverts
   * the field to the last real value rather than leaving bad text sitting in
   * it, which is what "prevent invalid dates" means at the input level.
   */
  const commitDraft = () => {
    if (draft === null) return;
    if (draft === '') {
      commit('');
    } else {
      const typed = parseTyped(draft);
      const inRange = typed && !(minDate && typed < minDate) && !(maxDate && typed > maxDate);
      if (typed && inRange) commit(toIso(typed));
    }
    setDraft(null);
  };

  /*
   * The year dropdown needs bounds to build its option list. Left unset, the
   * calendar defaults to 100 years back and only to the END of the current
   * year — which would make a rego expiring next year, or any other
   * forward-dated field, unreachable through the dropdown. A field that
   * already has a `min`/`max` keeps that as its real bound; one that does not
   * gets a generous but finite range instead of the library's default.
   */
  const today = new Date();
  const fallbackStart = new Date(today.getFullYear() - 100, 0, 1);
  const fallbackEnd = new Date(today.getFullYear() + 20, 11, 31);

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
        <div
          className={cn(
            'flex h-9 w-full items-center gap-1.5 rounded-md border border-input bg-background py-1 pr-2.5 pl-3 text-sm shadow-xs transition-colors',
            'has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring',
            'has-[[aria-invalid=true]]:border-destructive has-[[aria-invalid=true]]:ring-destructive/30',
            disabled && 'cursor-not-allowed opacity-50',
            className,
          )}
        >
          {/* Typed directly, DD/MM/YYYY — the calendar below is the alternative, not the only way in. */}
          <input
            id={triggerId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            disabled={disabled}
            placeholder={placeholder === 'Choose a date' ? 'DD/MM/YYYY' : placeholder}
            value={displayValue}
            onChange={(event) => setDraft(maskDraft(event.target.value))}
            onBlur={(event: FocusEvent<HTMLInputElement>) => {
              commitDraft();
              onBlur?.(event);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitDraft();
            }}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
            {...triggerProps}
          />

          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Open calendar"
              className="focus-ring -mr-1 grid shrink-0 place-items-center rounded p-0.5 text-muted-foreground disabled:cursor-not-allowed"
            >
              <CalendarIcon aria-hidden className="size-4" />
            </button>
          </PopoverTrigger>
        </div>

        <PopoverContent className="w-auto" container={portalContainer}>
          <Calendar
            mode="single"
            autoFocus
            selected={selected}
            defaultMonth={selected}
            startMonth={minDate ?? fallbackStart}
            endMonth={maxDate ?? fallbackEnd}
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
