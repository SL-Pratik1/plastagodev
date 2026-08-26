import { Loader2Icon } from 'lucide-react';
import { cn } from '../lib/utils.js';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <Loader2Icon className={cn('size-4 animate-spin text-muted-foreground', className)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
