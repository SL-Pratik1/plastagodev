import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/**
 * A surface that sits above the canvas.
 *
 * The elevation is deliberately small — one soft shadow, not a stack. Cards on
 * this console tile edge to edge across a dashboard, and anything heavier turns
 * a grid of eight into a relief map. What the shadow has to do is separate the
 * card from `--canvas` behind it; the border alone did not, because the border
 * and the canvas are close in value by design.
 */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card text-card-foreground',
        'shadow-[0_1px_2px_0_rgb(16_24_16/0.04),0_1px_3px_0_rgb(16_24_16/0.06)]',
        // A drop shadow is invisible on a dark canvas: dark-on-dark reads as
        // nothing. A hairline top highlight is what conveys "raised" there.
        'dark:shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('text-base font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 p-5 pt-0', className)} {...props} />;
}
