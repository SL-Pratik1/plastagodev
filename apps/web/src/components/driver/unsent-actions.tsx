import { Button, ConfirmDialog, Dialog, useToast } from '@plastago/ui';
import { CloudOffIcon } from 'lucide-react';
import { useState } from 'react';
import { formatTime } from '@/lib/format';
import { discardOperation, retryOperation } from '@/offline/outbox';
import { useUnsentActions, type UnsentAction } from '@/offline/use-offline-state';

/** What each queued path does, in the driver's words. Keyed by its last segment. */
const ACTION_LABELS: Record<string, string> = {
  status: 'Status change',
  complete: 'Job completed',
  weights: 'Bags and weights',
  futile: 'Could not collect',
  unarrive: 'Unarrive',
  contamination: 'Contamination report',
  messages: 'Message to the office',
  uploaded: 'Photo upload',
  'pre-start': 'Pre-start check',
  'risk-assessment': 'Site risk assessment',
  'tip-off': 'Tip-off',
  defects: 'Defect report',
};

function describe(action: UnsentAction): string {
  if (action.method === 'DELETE' && action.path.includes('/photos/')) return 'Photo removal';
  const last = action.path.split('/').filter(Boolean).at(-1) ?? '';
  return ACTION_LABELS[last] ?? 'A change';
}

/**
 * What this phone has not got to the office, and why (Matt, 21 Oct).
 *
 * The phone said "completed" while the office saw the job on site, and nothing
 * on the phone said a thing had failed: a refused action was retried out of
 * sight and then dropped. It now waits here with the server's reason, to send
 * again or discard. Renders nothing while everything is sending normally.
 */
export function UnsentActions() {
  const toast = useToast();
  const actions = useUnsentActions();
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [discarding, setDiscarding] = useState<UnsentAction | null>(null);

  if (actions.length === 0) return null;

  const resend = async (action: UnsentAction) => {
    setBusyId(action.id);
    try {
      await retryOperation(action.id);
      toast.success('Sending again', `${describe(action)} is back in the queue.`);
    } catch {
      toast.error('Could not send it again', 'Try again in a moment.');
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (action: UnsentAction) => {
    setBusyId(action.id);
    try {
      await discardOperation(action.id);
      toast.success('Discarded', `${describe(action)} will not be sent. Ring the office if it mattered.`);
      setDiscarding(null);
    } catch {
      toast.error('Could not discard it', 'Try again in a moment.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        onClick={() => {
          setOpen(true);
        }}
      >
        <CloudOffIcon aria-hidden />
        {actions.length} not sent
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        title="Not sent to the office"
        description="These are on this phone only. The office does not see them until they send."
        footer={
          <Button
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            Close
          </Button>
        }
      >
        <ul className="divide-y divide-border">
          {actions.map((action) => (
            <li key={action.id} className="space-y-2 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{describe(action)}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatTime(action.createdAt)}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                {action.stopped ? 'Stopped' : 'Retrying by itself'}
                {action.lastError ? ` — ${action.lastError}` : ''}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busyId === action.id}
                  onClick={() => void resend(action)}
                >
                  Send again
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyId === action.id}
                  onClick={() => {
                    setDiscarding(action);
                  }}
                >
                  Discard
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>

      <ConfirmDialog
        open={discarding !== null}
        onCancel={() => {
          setDiscarding(null);
        }}
        onConfirm={() => {
          if (discarding) void discard(discarding);
        }}
        title="Discard this?"
        description="It is deleted from this phone and the office never receives it."
        confirmLabel="Discard"
        tone="destructive"
        pending={discarding !== null && busyId === discarding.id}
      />
    </>
  );
}
