import type { VehiclePreStart } from '@plastago/shared';
import { Alert, Badge, Button, Dialog } from '@plastago/ui';
import { formatDateTime } from '@/lib/format';

const STATE_LABELS = { pass: 'Pass', fail: 'Problem', 'not-applicable': 'N/A' } as const;
const STATE_BADGES = { pass: 'success', fail: 'destructive', 'not-applicable': 'outline' } as const;

export interface PreStartCheckDialogProps {
  /** The check to show; null keeps the dialog closed. */
  check: VehiclePreStart | null;
  rego: string;
  onClose: () => void;
}

/**
 * One pre-start check in full, opened from the vehicle's "Pre-start checks" tab.
 *
 * Matt, 21 Oct: "Every time that form is filled, the detail should be logged
 * against the vehicle." Older checks kept only the failed items, so for those
 * the dialog says so instead of showing a list that looks complete.
 */
export function PreStartCheckDialog({ check, rego, onClose }: PreStartCheckDialogProps) {
  return (
    <Dialog
      open={check !== null}
      onClose={onClose}
      title={`Pre-start check — ${rego}`}
      description={
        check
          ? `${formatDateTime(check.completedAt)} · ${check.driverName} · ${check.odometerKm.toLocaleString('en-AU')} km`
          : undefined
      }
      size="lg"
      footer={
        <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">
          Close
        </Button>
      }
    >
      {check && (
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {check.itemsChecked} items checked ·{' '}
            {check.failedItems.length === 0
              ? 'no problems'
              : `${String(check.failedItems.length)} problem${check.failedItems.length === 1 ? '' : 's'}, each sent to the office as a defect`}
          </p>

          {check.items.length > 0 ? (
            <ul className="divide-y divide-border">
              {check.items.map((item) => (
                <li key={item.key} className="flex items-start gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{item.label}</p>
                    {item.note && <p className="text-xs text-muted-foreground">{item.note}</p>}
                  </div>
                  <Badge variant={STATE_BADGES[item.state]}>{STATE_LABELS[item.state]}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <Alert variant="neutral" title="Only the problems were kept on this check">
                It was saved before every answer was recorded, so only the failed items are shown.
              </Alert>
              {check.failedItems.length > 0 && (
                <ul className="divide-y divide-border">
                  {check.failedItems.map((item) => (
                    <li key={item.key} className="flex items-start gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">{item.label}</p>
                        {item.note && (
                          <p className="text-xs text-muted-foreground">{item.note}</p>
                        )}
                      </div>
                      <Badge variant="destructive">Problem</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
