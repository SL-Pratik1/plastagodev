import { Button, Spinner } from '@plastago/ui';

export interface UnsavedBarProps {
  visible: boolean;
  onSave: () => void;
  onDiscard: () => void;
  pending?: boolean;
  label?: string;
}

/**
 * The unsaved-changes bar.
 *
 * Sticky at the bottom of the section it belongs to, so it cannot scroll out of
 * sight while the form is dirty. It states the situation and offers both exits —
 * which is what a modal "are you sure?" fails to do, because that only appears
 * once it is already too late and only offers to cancel the navigation.
 *
 * `aria-live="polite"` so a screen-reader user is told the form became dirty
 * rather than discovering it when they try to leave.
 */
export function UnsavedBar({
  visible,
  onSave,
  onDiscard,
  pending = false,
  label = 'You have unsaved changes',
}: UnsavedBarProps) {
  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky bottom-4 z-20 flex flex-col gap-3 rounded-lg border border-warning/40 bg-card p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={pending}>
          Discard
        </Button>
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending && <Spinner className="text-current" />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
