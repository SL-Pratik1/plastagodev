import type { ReactNode } from 'react';
import { cn } from '../lib/utils.js';

/** Props a control must spread to be correctly labelled and described. */
export interface FieldControlProps {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
  'aria-required': true | undefined;
}

export interface FieldProps {
  id: string;
  label: ReactNode;
  /** Helper text. Rendered above the error so both can be present. */
  hint?: ReactNode;
  /** Validation message. Presence is what marks the field invalid. */
  error?: string | undefined;
  required?: boolean;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + hint + error, wired correctly, every time.
 *
 * The render-prop signature is the point. Getting `aria-invalid`,
 * `aria-describedby` and the hint/error id pair right is fiddly and easy to
 * half-do — and a half-done version is invisible in review because the field
 * still *looks* fine. Here the control cannot be rendered without receiving
 * them:
 *
 *   <Field id="mobile" label="Mobile number" error={errors.mobile?.message}>
 *     {(control) => <Input {...control} {...register('mobile')} />}
 *   </Field>
 *
 * `aria-describedby` points at the hint AND the error when both exist, so a
 * screen-reader user hears the format rule and what went wrong.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="flex items-center gap-1 text-sm font-medium select-none">
        {label}
        {required && (
          <>
            <span aria-hidden className="text-destructive">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        )}
      </label>

      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required ? true : undefined,
      })}

      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}

      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
