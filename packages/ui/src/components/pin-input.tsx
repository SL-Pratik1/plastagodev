import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '../lib/utils.js';

export interface PinInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  /** Fired once the last box is filled — auto-submit hangs off this. */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  /** Names the group, e.g. "One-time code". */
  label: string;
  describedBy?: string | undefined;
  className?: string;
}

/**
 * Segmented numeric code entry, for the OTP screens (§9 A1/A2).
 *
 * The details that matter here are all about not making someone re-type a code
 * they already have:
 *  • `autocomplete="one-time-code"` on the first box, so iOS and Android offer
 *    the code straight from the SMS — for a driver in a truck cab this is the
 *    difference between two taps and squinting between two apps.
 *  • Paste fills every box, whichever box was focused. People paste six digits.
 *  • Backspace on an empty box steps back and clears the previous one, which is
 *    what everyone expects and almost nothing implements.
 *  • `inputMode="numeric"` so phones show the number pad, not a QWERTY keyboard.
 *
 * A single `<input maxlength=6>` would be simpler, but boxes tell the user how
 * many digits to expect before they start typing.
 */
export function PinInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
  label,
  describedBy,
  className,
}: PinInputProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const commit = (next: string) => {
    const trimmed = next.slice(0, length);
    onChange(trimmed);
    if (trimmed.length === length) onComplete?.(trimmed);
  };

  const focusBox = (index: number) => {
    refs.current[Math.max(0, Math.min(index, length - 1))]?.focus();
  };

  const setDigit = (index: number, digit: string) => {
    const chars = value.padEnd(length, ' ').split('');
    chars[index] = digit;
    commit(chars.join('').replace(/ /g, '').slice(0, length));
  };

  const onBoxChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) {
      setDigit(index, '');
      return;
    }

    // Typing over a filled box, or an autofilled multi-digit value.
    if (digits.length > 1) {
      const filled = (value.slice(0, index) + digits).slice(0, length);
      commit(filled);
      focusBox(filled.length);
      return;
    }

    const chars = value.split('');
    chars[index] = digits;
    commit(chars.join('').slice(0, length));
    if (index < length - 1) focusBox(index + 1);
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      event.preventDefault();
      const chars = value.split('');
      chars[index - 1] = '';
      commit(chars.join('').replace(/\s/g, ''));
      focusBox(index - 1);
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    }
    if (event.key === 'ArrowRight' && index < length - 1) {
      event.preventDefault();
      focusBox(index + 1);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!digits) return;
    event.preventDefault();
    commit(digits);
    focusBox(digits.length);
  };

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className={cn('flex gap-2', className)}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="text"
          inputMode="numeric"
          // Only the first box: repeating it makes some browsers autofill all six
          // with the same digit.
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoFocus={autoFocus && index === 0}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-label={`Digit ${String(index + 1)} of ${String(length)}`}
          value={value[index] ?? ''}
          onChange={(event) => {
            onBoxChange(index, event.target.value);
          }}
          onKeyDown={(event) => {
            onKeyDown(index, event);
          }}
          onPaste={onPaste}
          onFocus={(event) => {
            event.target.select();
          }}
          className={cn(
            'h-13 w-full min-w-0 rounded-lg border bg-background text-center font-display text-xl font-semibold tabular-nums shadow-xs transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-50',
            invalid ? 'border-destructive' : 'border-input',
          )}
        />
      ))}
    </div>
  );
}
