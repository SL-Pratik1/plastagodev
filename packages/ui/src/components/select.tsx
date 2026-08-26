import { ChevronDownIcon } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * A styled NATIVE `<select>`.
 *
 * Chosen over a custom listbox on purpose. The native control gets the platform
 * picker on a phone — a full-height wheel the driver can hit with a thumb in a
 * glove — plus type-ahead, keyboard support and screen-reader behaviour that no
 * hand-rolled div can match. The only thing we lose is per-option markup, which
 * a filter dropdown does not need.
 *
 * Where rich options genuinely are required (an account picker showing code,
 * name and rate card), build a dedicated combobox rather than making this
 * component grow.
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        className={cn(
          'h-9 w-full appearance-none rounded-md border border-input bg-background py-1 pl-3 pr-8 text-sm shadow-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}
