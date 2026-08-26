import { Alert, Badge, Card, CardContent, Switch, buttonVariants, useToast } from '@plastago/ui';
import { CloudUploadIcon, LogOutIcon, PhoneIcon, RefreshCwIcon, WrenchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth, useDriver } from '@/features/auth/auth-context';
import { flushOutbox } from '@/offline/outbox';
import { useOnlineStatus, useOutboxSummary } from '@/offline/use-offline-state';
import {
  isSimulatedOffline,
  setSimulatedOffline,
  subscribeSimulatedOffline,
} from '@/offline/transport';
import { useRunSheet } from '@/features/run/queries';
import { RUN_DATE } from '@/services/mock/fixtures';

/**
 * The driver's own page — and the sync queue (M4.12).
 *
 * ── The queue is a screen, not a spinner ──────────────────────────────────
 * M4.12 requires that the driver *"can see clearly what has and has not
 * synced"*. With no error-tracking vendor (§6A.8), the driver is the only person
 * who can tell us a queue is stuck — so the count, the last successful sync and
 * a manual retry all have to be somewhere they can find and read out over the
 * phone.
 *
 * ── The offline switch is a demo control, and it says so ───────────────────
 * Offline-first is the hardest thing in this app to *show* anyone: turning off
 * real Wi-Fi mid-meeting is unreliable and unrepeatable, and page code cannot
 * fake `navigator.onLine`. So the switch is here, labelled as a demo affordance,
 * and it goes out with the mock services.
 */
export function MePage() {
  const driver = useDriver();
  const toast = useToast();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const online = useOnlineStatus();
  const { pending, failed, lastSyncAt } = useOutboxSummary();
  const { data: day } = useRunSheet(RUN_DATE);

  const [offlineMode, setOfflineMode] = useState(() => isSimulatedOffline());
  const [retrying, setRetrying] = useState(false);

  // The switch can also be flipped from elsewhere, so mirror the source of truth
  // rather than assuming this component is the only writer.
  useEffect(() => subscribeSimulatedOffline(setOfflineMode), []);

  const retry = async () => {
    setRetrying(true);
    try {
      const { sent, failed: stillFailed } = await flushOutbox();
      toast.success(
        sent > 0 ? `${String(sent)} sent` : 'Nothing sent',
        stillFailed > 0
          ? `${String(stillFailed)} still waiting. It keeps trying on its own.`
          : online
            ? undefined
            : 'You are offline — it will go when you have signal.',
      );
    } finally {
      setRetrying(false);
    }
  };

  const leave = async () => {
    if (pending > 0 || failed > 0) {
      toast.error(
        'You still have work to send',
        'Stay signed in until the badge says Synced, or it stays on this phone.',
      );
      return;
    }
    await signOut();
    await navigate('/sign-in', { replace: true });
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">{driver.name}</h1>
        <p className="text-sm text-muted-foreground">
          {driver.jobTitle ?? 'Driver'} · {driver.mobile ?? ''}
        </p>
      </header>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Sending to the office</p>
              <p className="text-xs text-muted-foreground">
                {pending === 0 && failed === 0
                  ? lastSyncAt === null
                    ? 'Nothing waiting.'
                    : `Everything sent. Last at ${new Date(lastSyncAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })}.`
                  : `${String(pending + failed)} action${pending + failed === 1 ? '' : 's'} waiting.`}
              </p>
            </div>
            <Badge variant={failed > 0 ? 'destructive' : pending > 0 ? 'secondary' : 'success'}>
              {failed > 0
                ? `${String(failed)} stuck`
                : pending > 0
                  ? `${String(pending)} queued`
                  : 'Synced'}
            </Badge>
          </div>

          {failed > 0 && (
            <Alert variant="warning" title="Some things have not gone through">
              They keep retrying on their own. If the count is not going down after a while, ring
              the office and read them this number.
            </Alert>
          )}

          <button
            type="button"
            onClick={() => void retry()}
            disabled={retrying}
            className={`${buttonVariants({ variant: 'outline' })} min-h-12 w-full`}
          >
            <RefreshCwIcon aria-hidden />
            {retrying ? 'Trying…' : 'Try sending now'}
          </button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <CloudUploadIcon aria-hidden className="size-4 text-muted-foreground" />
                Work offline
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Demo control. Turn it on and the app behaves as if you have no signal — everything
                still works and queues up.
              </p>
            </div>
            <Switch
              checked={offlineMode}
              onCheckedChange={(value) => {
                setSimulatedOffline(value);
                toast.info(
                  value ? 'Offline mode on' : 'Offline mode off',
                  value ? 'Nothing will be sent until you turn it off.' : 'Sending what is queued.',
                );
              }}
              aria-label="Simulate being offline"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-1 py-4 text-sm">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Today
          </p>
          <p>
            {day?.vehicleRego ?? '—'} · {day?.vehicleLabel ?? ''}
          </p>
          <p className="text-muted-foreground">
            {day === undefined
              ? ''
              : `${String(day.stops.length)} stops · pre-start ${day.preStartCompletedAt === null ? 'not done' : 'done'}`}
          </p>
        </CardContent>
      </Card>

      <Link
        to="/report"
        className={`${buttonVariants({ variant: 'outline' })} min-h-14 w-full justify-start`}
      >
        <WrenchIcon aria-hidden />
        Report a problem with the truck
      </Link>

      <a
        href="tel:1300395438"
        className={`${buttonVariants({ variant: 'outline' })} min-h-14 w-full justify-start`}
      >
        <PhoneIcon aria-hidden />
        Ring the office — 1300 395 438
      </a>

      <button
        type="button"
        onClick={() => void leave()}
        className="focus-ring flex min-h-14 w-full items-center justify-start gap-2 rounded-lg px-4 text-sm font-medium text-destructive"
      >
        <LogOutIcon aria-hidden className="size-4" />
        Sign out
      </button>

      <p className="pb-2 text-center text-xs text-muted-foreground">
        Demo build on sample data · all times Australia/Sydney
      </p>
    </div>
  );
}
