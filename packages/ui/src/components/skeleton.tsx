import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * A loading placeholder.
 *
 * `aria-hidden` is deliberate: the shape is decoration. Whatever renders a set
 * of these owns the announcement (`role="status"` with a label), so a screen
 * reader hears "Loading jobs" once instead of eleven anonymous boxes.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  );
}

/** Text-shaped skeleton lines, with the last one short so it reads as prose. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-4', index === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
