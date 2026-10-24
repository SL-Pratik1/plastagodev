import { Button, useToast } from '@plastago/ui';
import { MessageSquareIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  useMarkNotificationsRead,
  useUnreadDriverMessages,
} from '@/features/notifications/queries';
import { describeError } from '@/lib/error-message';
import { formatTime } from '@/lib/format';

/** At most this many at once; the rest are in the bell. */
const MAX_SHOWN = 3;

const DISMISSED_KEY = 'plastago.driver-message-popup.dismissed';

/** Pop-ups closed on this browser. A convenience only — never shared, may be empty. */
function readDismissed(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: ReadonlySet<string>): void {
  try {
    // The newest fifty is plenty: an old id is long since read anyway.
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    // Private mode or blocked storage: it just shows again next visit.
  }
}

/**
 * A bubble, bottom left, for each driver message nobody has opened (Matt,
 * 21 Oct). The bell already had them; the bell is easy to miss.
 *
 * "Open messages" goes to that job's driver thread and marks it read, exactly
 * as the bell does. Closing it hides the bubble on this browser and leaves the
 * message unread in the bell.
 */
export function DriverMessagePopup() {
  const navigate = useNavigate();
  const toast = useToast();
  const markRead = useMarkNotificationsRead();
  const { data } = useUnreadDriverMessages();
  const [dismissed, setDismissed] = useState(readDismissed);

  const unseen = (data ?? []).filter((item) => !dismissed.has(item.id));
  if (unseen.length === 0) return null;

  const dismiss = (id: string) => {
    const next = new Set(dismissed).add(id);
    setDismissed(next);
    saveDismissed(next);
  };

  const open = (id: string, href: string) => {
    markRead.mutateAsync([id]).catch((error: unknown) => {
      const described = describeError(error);
      toast.error('Could not mark that message read', described.detail ?? described.title);
    });
    void navigate(href);
  };

  const more = unseen.length - MAX_SHOWN;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {unseen.slice(0, MAX_SHOWN).map((item) => (
        <div key={item.id} className="rounded-lg border bg-card p-3 text-card-foreground shadow-lg">
          <div className="flex items-start gap-2">
            <MessageSquareIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="line-clamp-2 text-sm text-muted-foreground">{item.body}</p>
              <p className="mt-1 text-xs text-muted-foreground tabular-nums">
                {formatTime(item.at)}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close this message pop-up"
              className="focus-ring -m-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
              onClick={() => {
                dismiss(item.id);
              }}
            >
              <XIcon aria-hidden className="size-4" />
            </button>
          </div>
          <Button
            size="sm"
            className="mt-2 w-full"
            onClick={() => {
              open(item.id, item.href);
            }}
          >
            Open messages
          </Button>
        </div>
      ))}
      {more > 0 && (
        <p className="rounded-md bg-card px-3 py-1.5 text-center text-xs text-muted-foreground shadow">
          {more} more driver {more === 1 ? 'message' : 'messages'} in the bell
        </p>
      )}
    </div>
  );
}
