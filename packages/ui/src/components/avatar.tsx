import { cn } from '../lib/utils.js';

export interface AvatarProps {
  name: string;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}

const SIZE = {
  sm: 'size-7 text-[10px]',
  default: 'size-9 text-xs',
  lg: 'size-11 text-sm',
} as const;

/** First letter of the first two words — "Matthew Browne" → "MB". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/**
 * Initials-only avatar. There are no user photos in this product and adding an
 * upload pipeline for decoration would be scope for nothing — so this is the
 * finished component, not a placeholder for an image one.
 */
export function Avatar({ name, size = 'default', className }: AvatarProps) {
  return (
    <span
      aria-hidden
      title={name}
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full bg-brand-200 font-display font-semibold text-brand-800 select-none',
        SIZE[size],
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
