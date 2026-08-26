import { CheckIcon, MinusIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type'> {
  /** Header checkbox with some — not all — rows selected. */
  indeterminate?: boolean;
}

/**
 * A real `<input type="checkbox">` with a painted box on top.
 *
 * The input stays in the accessibility tree and in the tab order; it is only
 * visually hidden. That keeps form submission, `required`, label association
 * and screen-reader announcement working exactly as the platform intends,
 * which a `role="checkbox"` div has to reimplement and usually gets wrong.
 */
export function Checkbox({ className, indeterminate = false, ...props }: CheckboxProps) {
  return (
    <span className={cn('relative inline-flex size-4 shrink-0 align-middle', className)}>
      <input
        type="checkbox"
        // `peer` + `sr-only`-style positioning: present to the platform, invisible to the eye.
        className="peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[4px] border border-input bg-background transition-colors checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
        ref={(node) => {
          if (node) node.indeterminate = indeterminate;
        }}
        {...props}
      />
      {indeterminate ? (
        <MinusIcon
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 peer-indeterminate:opacity-100"
          strokeWidth={3}
        />
      ) : (
        <CheckIcon
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 peer-checked:opacity-100"
          strokeWidth={3}
        />
      )}
    </span>
  );
}
