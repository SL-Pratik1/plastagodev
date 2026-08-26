import { Badge } from '@plastago/ui';
import { useOnlineStatus, useOutboxSummary } from '@/offline/use-offline-state';

/**
 * Persistent sync state, always visible in the header.
 *
 * Not a nicety: the driver must be able to see clearly what has and has not
 * synced (§M4.12). With no error-tracking vendor (§6A.8), a stuck queue is only
 * discovered because a driver tells us — which they cannot do if the app hides it.
 */
export function SyncIndicator() {
  const online = useOnlineStatus();
  const { pending, failed, lastSyncAt } = useOutboxSummary();

  if (!online) {
    return (
      <Badge variant="warning" title="Working offline — actions are queued locally">
        Offline{pending > 0 ? ` · ${String(pending)} queued` : ''}
      </Badge>
    );
  }

  if (failed > 0) {
    return (
      <Badge variant="destructive" title="Some queued actions could not be sent">
        {failed} not sent
      </Badge>
    );
  }

  if (pending > 0) {
    return <Badge variant="secondary">Syncing {pending}…</Badge>;
  }

  return (
    <Badge
      variant="success"
      title={
        lastSyncAt ? `Last sync ${new Date(lastSyncAt).toLocaleTimeString('en-AU')}` : undefined
      }
    >
      Synced
    </Badge>
  );
}
