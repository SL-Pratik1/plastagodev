import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

export interface SeparatorProps extends ComponentProps<'div'> {
  orientation?: 'horizontal' | 'vertical';
  /** A separator that only groups visually should not be announced. */
  decorative?: boolean;
}

export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps) {
  return (
    <div
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'separator', 'aria-orientation': orientation })}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
