import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

export function Textarea({ className, rows = 4, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      rows={rows}
      className={cn(
        'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/30',
        'field-sizing-content min-h-20 resize-y',
        className,
      )}
      {...props}
    />
  );
}
