import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { usePortalContainer } from '../lib/portal-container.js';
import { cn } from '../lib/utils.js';

/**
 * Select — a shadcn/ui (Radix) listbox with a real `<select>` underneath.
 *
 * ── Why both ──────────────────────────────────────────────────────────────
 * The visible control is Radix, so the popup is OUR popup: brand colours, our
 * radius, our type, a check on the active row, and identical rendering on every
 * OS. A native `<select>` renders its list with the operating system's own
 * widget — the blue-highlighted Windows list — which is the single loudest
 * "unfinished" signal in a console that is otherwise fully themed.
 *
 * But a native `<select>` is still rendered, visually hidden, and it remains the
 * source of truth. It is what `register('field')` from react-hook-form attaches
 * its `ref` to, what carries `name` into a form submission, and what fires the
 * `change` event those call sites' `onChange` handlers already expect. Dropping
 * it would have broken every RHF-bound dropdown in the app quietly — the field
 * would look right and submit nothing.
 *
 * ── Call-site compatibility ───────────────────────────────────────────────
 * The public API is unchanged: pass `<option>` and `<optgroup>` children, read
 * `event.target.value` in `onChange`. Existing screens did not need editing.
 * `onValueChange` is also accepted for new code that prefers it.
 *
 * ── The empty-value sentinel ──────────────────────────────────────────────
 * Radix reserves `''` to mean "nothing selected" and throws if an item uses it.
 * Filter dropdowns across the app legitimately use `<option value="">All
 * statuses</option>`, so `''` is swapped for a sentinel on the way into Radix
 * and swapped back on the way out. Call sites never see it.
 */

/** Not a value any real option uses, and never surfaced to a call site. */
const EMPTY_VALUE = '__pg_empty__';

const toRadix = (value: string) => (value === '' ? EMPTY_VALUE : value);
const fromRadix = (value: string) => (value === EMPTY_VALUE ? '' : value);

interface OptionModel {
  value: string;
  label: string;
  disabled?: boolean;
}

interface GroupModel {
  /** `null` for options sitting directly on the select, outside any optgroup. */
  label: string | null;
  options: OptionModel[];
}

/**
 * The text of an option's children.
 *
 * ── Why this is not just `typeof label === 'string'` ───────────────────────
 * `<option>{months} months</option>` hands React an ARRAY of nodes — `[12, ' months']`
 * — not a string. The previous single-node check fell through to `''` for it,
 * so the row rendered blank in the list and blank on the trigger while the value
 * behind it was perfectly correct. A dropdown of empty rows reads as "the
 * options failed to load", which is the one thing that had not gone wrong.
 *
 * Flattening keeps the stated contract — options carry plain text, anything
 * richer belongs in a bespoke combobox — while covering the interpolation every
 * call site naturally reaches for.
 */
function optionLabel(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionLabel).join('');
  return '';
}

/**
 * Flattens `<option>` / `<optgroup>` children into a model Radix can render.
 * Reading children is what keeps the call sites untouched — they keep writing
 * plain HTML options and get a themed listbox.
 */
function readOptions(children: ReactNode): GroupModel[] {
  const groups: GroupModel[] = [];

  const pushOption = (element: ReactElement<ComponentProps<'option'>>, groupLabel: string | null) => {
    const { value, children: label, disabled } = element.props;
    let bucket = groups.at(-1);
    if (!bucket || bucket.label !== groupLabel) {
      bucket = { label: groupLabel, options: [] };
      groups.push(bucket);
    }
    bucket.options.push({
      value: String(value ?? ''),
      label: optionLabel(label),
      disabled,
    });
  };

  const walk = (nodes: ReactNode, groupLabel: string | null) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;

      if (child.type === 'option') {
        pushOption(child as ReactElement<ComponentProps<'option'>>, groupLabel);
        return;
      }

      if (child.type === 'optgroup') {
        const props = (child as ReactElement<ComponentProps<'optgroup'>>).props;
        walk(props.children, props.label ?? null);
      }
    });
  };

  walk(children, null);
  return groups;
}

export interface SelectProps extends Omit<ComponentProps<'select'>, 'onChange' | 'size'> {
  /** Fired with the raw value, for code that does not want a change event. */
  onValueChange?: (value: string) => void;
  onChange?: ComponentProps<'select'>['onChange'];
  /** Shown on the trigger when the current value matches no option. */
  placeholder?: string;
  /** Applied to the visible trigger. */
  className?: string;
}

export function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  onValueChange,
  disabled,
  name,
  required,
  placeholder,
  ref,
  onBlur,
  autoComplete,
  form,
  id,
  ...triggerProps
}: SelectProps) {
  const nativeRef = useRef<HTMLSelectElement>(null);
  const fallbackId = useId();
  const triggerId = id ?? fallbackId;

  /*
   * Stable across renders, and that is load-bearing rather than tidiness.
   *
   * An inline `ref={(node) => …}` is a new function every render, so React
   * detaches it (calls it with `null`) and reattaches it each time. That is
   * harmless for a plain ref box, but the ref being forwarded here belongs to
   * react-hook-form, whose ref callback populates the element from
   * `defaultValues` only on a real mount — a detach/reattach cycle re-registers
   * the field WITHOUT rewriting the DOM value. Combined with this component
   * re-rendering to mirror the value, the write was being undone, and fields
   * with a default (`serviceLevel: 'standard'`) rendered blank.
   *
   * `useRef` rather than `useCallback`: the incoming `ref` from `register()` is
   * itself a fresh function each render, so a dependency on it would defeat the
   * memo. The latest one is read out of a box instead.
   */
  const forwardedRef = useRef(ref);

  /*
   * Kept in an effect, not written during render — a render-phase ref write is
   * unsafe under concurrent rendering, and the React Compiler rejects it. Mount
   * is still covered: `useRef(ref)` seeds the box with the first render's ref,
   * and `attachRef` runs during commit, before any effect.
   */
  useEffect(() => {
    forwardedRef.current = ref;
  }, [ref]);

  const attachRef = useCallback((node: HTMLSelectElement | null) => {
    nativeRef.current = node;
    const target = forwardedRef.current;
    if (typeof target === 'function') target(node);
    else if (target) target.current = node;
  }, []);

  /*
   * Where the list renders. Inside a `Dialog` — a native `<dialog>` sitting in
   * the browser's top layer — Radix's default `document.body` portal would draw
   * the list behind the dialog card and leave it inert, which reads as options
   * being missing rather than as a layering fault.
   */
  const portalContainer = usePortalContainer(nativeRef);

  const groups = readOptions(children);
  const isControlled = value !== undefined;

  /*
   * Whether `''` is a real, selectable choice here ("All statuses") or simply
   * means nothing has been picked yet.
   *
   * The distinction matters because Radix already uses `''` for the second
   * meaning. Only when the call site defines an actual empty-valued option does
   * it need swapping for the sentinel; substituting it unconditionally would
   * hand Radix a value matching no item on every not-yet-filled form field, and
   * the placeholder would never render.
   */
  const hasEmptyOption = groups.some((group) =>
    group.options.some((option) => option.value === ''),
  );

  /**
   * Mirrors the native element when the call site does not control the value.
   * `register('field')` is uncontrolled — RHF writes straight to `ref.value` on
   * reset and default-population, without React re-rendering — so the mirror is
   * re-synced after every render rather than only on mount. Without that, a form
   * reset leaves the trigger showing a stale label over a changed value.
   */
  const [mirrored, setMirrored] = useState(() => String(defaultValue ?? ''));

  /*
   * The absent dependency list is the point: this observes a value React does
   * not know changed. RHF writes to `ref.value` imperatively, so there is no
   * dependency that could express it. The equality guard means the update
   * settles in one extra render rather than looping.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const native = nativeRef.current;
    if (!native || isControlled) return;
    setMirrored((current) => (current === native.value ? current : native.value));
  });

  const current = isControlled ? String(value) : mirrored;

  const commit = (next: string) => {
    const native = nativeRef.current;

    if (native) {
      /*
       * Assign through the prototype's setter, not `native.value = next`. React
       * patches the instance property to track its own state; writing to the
       * patched one makes React believe the value never changed and the
       * subsequent `change` event is discarded. This is the standard escape
       * hatch for driving a React-managed input programmatically.
       */
      // Taking the setter off the prototype unbound is exactly the intent here;
      // it is applied to `native` explicitly on the next line.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) Reflect.apply(setter, native, [next]);
      native.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (!isControlled) setMirrored(next);
    onValueChange?.(next);
  };

  const selected = groups.flatMap((group) => group.options).find((option) => option.value === current);

  /*
   * What is left over is the descriptive markup a call site puts on the field —
   * `aria-describedby`, `aria-invalid` and `title` from `Field`, plus any
   * `data-*`. It is typed against `<select>` because the props as a whole have
   * to accept `{...register('field')}`, whose type carries select-shaped event
   * handlers. Those handlers are destructured out above and consumed by the
   * native element; only the descriptive attributes reach the trigger, so the
   * element type they are declared against is not meaningful here.
   */
  const describedProps = triggerProps as ComponentProps<typeof SelectPrimitive.Trigger>;

  return (
    <>
      {/*
        The form's real control. Kept in the layout (not `display:none`) so it
        can still be focused programmatically by validation, but pulled out of
        the tab order and the accessibility tree — the Radix trigger is what a
        keyboard or screen-reader user interacts with.
      */}
      <select
        ref={attachRef}
        name={name}
        form={form}
        required={required}
        disabled={disabled}
        autoComplete={autoComplete}
        onChange={onChange}
        onBlur={onBlur}
        {...(isControlled ? { value } : { defaultValue })}
        aria-hidden
        tabIndex={-1}
        className="sr-only"
      >
        {children}
      </select>

      <SelectPrimitive.Root
        value={hasEmptyOption ? toRadix(current) : current}
        onValueChange={(next) => {
          const chosen = fromRadix(next);

          /*
           * Radix emits `''` to mean "no selection", and it does so on mount —
           * not only in response to a click. Writing that through was destroying
           * real data: on the create-job form, react-hook-form populates the
           * native element from `defaultValues` when it attaches its ref, and
           * this echo fired straight afterwards and cleared it, leaving
           * "Service level" and "Freight item" blank over a form state that had
           * since been reset to empty.
           *
           * `''` is only ever a genuine choice when the call site declared an
           * option with that value ("All statuses"). Anywhere else it is Radix's
           * internal signal and must not reach the form.
           */
          if (chosen === '' && !hasEmptyOption) return;

          commit(chosen);
        }}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          id={triggerId}
          className={cn(
            /*
             * `pr-2.5` + `gap-1.5`, not the `px-3 gap-2` a card would use. The
             * chevron sits in the flex flow here, so every pixel it and the gap
             * take is a pixel the label loses — at the 10rem filter width that
             * was the difference between "Any invoice state" and "Any invoice
             * st…". The old native control could afford more because its arrow
             * was absolutely positioned and cost the text nothing.
             */
            'flex h-9 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-background py-1 pr-2.5 pl-3 text-sm shadow-xs transition-colors',
            'hover:border-ring/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0',
            'data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/30',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
            '[&>span]:truncate',
            className,
          )}
          {...describedProps}
        >
          <SelectPrimitive.Value placeholder={placeholder}>
            {selected?.label ?? placeholder ?? ''}
          </SelectPrimitive.Value>
          <SelectPrimitive.Icon asChild>
            <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>

        <SelectPrimitive.Portal container={portalContainer}>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            className={cn(
              'relative z-50 max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden',
              'rounded-lg border border-border bg-popover text-popover-foreground shadow-lg',
              'data-[state=open]:animate-[var(--animate-zoom-in)]',
            )}
          >
            <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
              <ChevronUpIcon aria-hidden className="size-4" />
            </SelectPrimitive.ScrollUpButton>

            <SelectPrimitive.Viewport className="p-1">
              {groups.map((group, groupIndex) => (
                <SelectPrimitive.Group key={group.label ?? `ungrouped-${String(groupIndex)}`}>
                  {group.label !== null && (
                    <SelectPrimitive.Label className="px-2 py-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                      {group.label}
                    </SelectPrimitive.Label>
                  )}
                  {group.options.map((option) => (
                    <SelectPrimitive.Item
                      key={option.value || EMPTY_VALUE}
                      value={toRadix(option.value)}
                      disabled={option.disabled}
                      className={cn(
                        'relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-sm outline-none select-none',
                        'data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
                        'data-[state=checked]:font-medium',
                        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
                      )}
                    >
                      <span className="absolute left-2 grid size-4 place-items-center">
                        <SelectPrimitive.ItemIndicator>
                          <CheckIcon aria-hidden className="size-4 text-primary" />
                        </SelectPrimitive.ItemIndicator>
                      </span>
                      <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    </SelectPrimitive.Item>
                  ))}
                </SelectPrimitive.Group>
              ))}
            </SelectPrimitive.Viewport>

            <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center bg-popover text-muted-foreground">
              <ChevronDownIcon aria-hidden className="size-4" />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}
