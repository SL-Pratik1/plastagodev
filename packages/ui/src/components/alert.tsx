import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils.js';

const alertVariants = cva('flex gap-3 rounded-lg border p-4 text-sm', {
  variants: {
    variant: {
      info: 'border-info/30 bg-info/8 text-foreground [&>svg]:text-info',
      success: 'border-success/30 bg-success/8 text-foreground [&>svg]:text-success',
      warning: 'border-warning/35 bg-warning/10 text-foreground [&>svg]:text-warning',
      destructive:
        'border-destructive/35 bg-destructive/8 text-foreground [&>svg]:text-destructive',
      neutral: 'border-border bg-muted text-foreground [&>svg]:text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'info' },
});

const VARIANT_ICON = {
  info: InfoIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
  destructive: CircleAlertIcon,
  neutral: InfoIcon,
} as const;

export interface AlertProps
  extends Omit<ComponentProps<'div'>, 'title'>, VariantProps<typeof alertVariants> {
  title?: ReactNode;
  /** Pass `false` to drop the leading icon on a dense inline alert. */
  icon?: boolean;
}

/**
 * A persistent, in-page message.
 *
 * The distinction from a toast is deliberate and worth keeping: an Alert is
 * *about the content on screen* and stays until the situation changes. A toast
 * confirms something that happened out of the user's line of sight and leaves.
 *
 * `destructive` alerts get `role="alert"` so assistive tech interrupts; the
 * quieter variants use `role="status"` so they are read in turn.
 */
export function Alert({
  className,
  variant = 'info',
  title,
  icon = true,
  children,
  ...props
}: AlertProps) {
  const Icon = VARIANT_ICON[variant ?? 'info'];

  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon && <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 flex-1 space-y-1">
        {title !== undefined && title !== null && (
          <p className="font-display font-semibold tracking-tight">{title}</p>
        )}
        {children !== undefined && children !== null && (
          <div className="text-muted-foreground [&_a]:underline [&_a]:underline-offset-4">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export { alertVariants };
