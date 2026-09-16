import type { Place } from '@plastago/shared';
import { Badge, Input, Spinner, cn } from '@plastago/ui';
import { CheckIcon, MapPinIcon, SearchIcon } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { usePlaceOptions } from '@/features/lookups/queries';

/**
 * Suburb type-ahead (Matt, 7:25).
 *
 * ── What it is really for ─────────────────────────────────────────────────
 * Matt asked for the convenience: *"as you're typing in an address, it will tell
 * you the suburbs that address could be in and you can just click the suburb and
 * it will paste in the suburb, state, postcode."*
 *
 * The convenience is the smaller half. With the Sites module gone (0:29) there
 * is no longer a saved record holding the **zone** that prices the job or the
 * **coordinate** that plots it — and neither can be typed. Picking a place from
 * a known list is what supplies both, which is why this control returns a whole
 * `Place` rather than a string.
 *
 * ── Why a chosen place is shown as a chip, not left in the box ────────────
 * Free text that *looks* chosen is the failure mode here: someone types
 * "Kellyvile", never opens the list, and the form has an unresolvable suburb and
 * no zone. So the input holds a search term, the selection is a separate visible
 * fact, and until something is actually picked the field reads as empty to the
 * form around it.
 *
 * ── Why there is no "use what I typed" escape hatch ───────────────────────
 * Because there is nothing sensible to do with it. An unlisted suburb has no
 * zone, and a job with no zone cannot be priced. Better to show "we do not
 * service that yet — call the office" than to accept a booking that will need a
 * phone call anyway, later, from someone confused about their invoice.
 */
export interface PlacePickerProps {
  id: string;
  value: Place | null;
  onChange: (place: Place | null) => void;
  placeholder?: string;
  disabled?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function PlacePicker({
  id,
  value,
  onChange,
  placeholder = 'Start typing a suburb or postcode',
  disabled,
  ...aria
}: PlacePickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const blurTimer = useRef<number | undefined>(undefined);

  const { data: places, isFetching } = usePlaceOptions(query);
  const options = places ?? [];

  const choose = (place: Place) => {
    onChange(place);
    setQuery('');
    setOpen(false);
  };

  if (value !== null) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-success/40 bg-success/5 px-3 py-2"
        data-testid="place-picker-selected"
      >
        <span className="flex min-w-0 items-center gap-2">
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{value.label}</span>
            {/*
              The zone is surfaced, not hidden. It is what decides the rate
              (M6.3), and the person booking should be able to see that a
              Wollongong job priced as Wollongong.
            */}
            {/* The zone NAME, resolved server-side. This used to render the raw slug. */}
          <span className="block text-xs text-muted-foreground">Zone: {value.zoneLabel}</span>
          </span>
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onChange(null);
            setQuery('');
          }}
          className="focus-ring shrink-0 rounded text-xs text-primary underline underline-offset-4"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          {...aria}
          id={id}
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          className="pl-9"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
          }}
          onBlur={() => {
            // Deferred: a click on an option fires blur before it fires click,
            // and closing immediately would swallow the selection.
            blurTimer.current = window.setTimeout(() => {
              setOpen(false);
            }, 120);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) => Math.min(current + 1, options.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter' && open) {
              const picked = options[activeIndex];
              if (picked) {
                event.preventDefault();
                choose(picked);
              }
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {isFetching && (
          <span className="absolute top-1/2 right-3 -translate-y-1/2">
            <Spinner label="Searching" />
          </span>
        )}
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {options.length === 0 ? (
            /*
              Says what to do next rather than just "no results". An unlisted
              suburb is a real answer — PlastaGo services three zones, not the
              whole state — and the office can add it.
            */
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {query.trim() === ''
                ? 'Start typing a suburb or postcode.'
                : `We do not service “${query.trim()}” yet — call the office on 1300 395 438.`}
            </li>
          ) : (
            options.map((place, index) => (
              <li key={place.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => {
                    setActiveIndex(index);
                  }}
                  onMouseDown={() => {
                    // Mousedown, not click: blur fires first otherwise.
                    window.clearTimeout(blurTimer.current);
                  }}
                  onClick={() => {
                    choose(place);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm',
                    index === activeIndex ? 'bg-accent text-accent-foreground' : 'bg-transparent',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <MapPinIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{place.label}</span>
                  </span>
                  <Badge variant="secondary">{place.zoneLabel}</Badge>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
