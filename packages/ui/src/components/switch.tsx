import { cn } from '../lib/utils.js';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Required when there is no visible <label> pointing at `id`. */
  'aria-label'?: string;
  'aria-describedby'?: string;
  className?: string;
}

/**
 * A toggle that takes effect immediately.
 *
 * `role="switch"` rather than a checkbox because the semantics differ and
 * screen readers say so: a switch is on/off *now*, a checkbox is a value that
 * will be saved when the form is submitted. Use this for "SMS notifications
 * enabled"; use Checkbox inside a form the user has to save.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className,
  ...aria
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onCheckedChange(!checked);
      }}
      className={cn(
        'focus-ring inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors',
        checked ? 'bg-primary' : 'bg-input',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      {...aria}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
