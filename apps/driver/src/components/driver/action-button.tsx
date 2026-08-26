import { Spinner, cn } from '@plastago/ui';
import type { LucideIcon } from 'lucide-react';

export interface ActionButtonProps {
  label: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: 'primary' | 'neutral' | 'danger' | 'warning';
  disabled?: boolean;
  pending?: boolean;
  onClick: () => void;
}

/**
 * The driver app's primary action control.
 *
 * ── Why this exists rather than using `Button size="lg"` ──────────────────
 * Because the size is not the only difference. A driver action needs three things
 * a normal button does not have room for:
 *
 *  • **A 64px target.** Well past the 44px minimum — the failure mode here is a
 *    mis-tap that marks the wrong job complete, and the driver is wearing gloves.
 *  • **A hint line.** "Complete job" alone does not say that photos are still
 *    missing, and finding that out after the tap is the wrong order.
 *  • **A tone that survives glare.** Full-width blocks of colour, not outlines,
 *    because a thin border on a phone in direct sun is invisible.
 */
const TONE: Record<NonNullable<ActionButtonProps['tone']>, string> = {
  primary: 'bg-primary text-primary-foreground',
  neutral: 'bg-card text-foreground border border-border',
  danger: 'bg-destructive text-destructive-foreground',
  warning: 'bg-warning text-warning-foreground',
};

export function ActionButton({
  label,
  hint,
  icon: Icon,
  tone = 'primary',
  disabled = false,
  pending = false,
  onClick,
}: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        'focus-ring flex min-h-16 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-opacity',
        TONE[tone],
        (disabled || pending) && 'opacity-50',
      )}
    >
      {pending ? (
        <Spinner label="Working" />
      ) : (
        Icon && <Icon aria-hidden className="size-6 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-base leading-tight font-semibold">{label}</span>
        {hint !== undefined && (
          <span className="mt-0.5 block text-xs leading-snug opacity-85">{hint}</span>
        )}
      </span>
    </button>
  );
}
