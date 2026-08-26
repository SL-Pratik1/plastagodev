import { Alert, Button, Dialog, useToast } from '@plastago/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { formatCountdown, useCountdown } from '@/lib/use-countdown';
import { useAuth } from './auth-context';

const WARN_WITHIN_SECONDS = 5 * 60;

/**
 * Warns before the session lapses, and handles it when it does.
 *
 * ── Why warn at all ───────────────────────────────────────────────────────
 * Because the alternative is discovering it mid-save. The office fills in long
 * forms — a job, an account, a set of contacts — and a session that dies
 * silently turns that into a failed request and lost typing. A warning five
 * minutes out costs one dialog and saves the work.
 *
 * ── Why the expiry path is a dialog, not a redirect ───────────────────────
 * On expiry the user is NOT thrown to the sign-in screen. Their unsaved work is
 * still on the page behind this dialog, and yanking the route away would discard
 * it without asking. They are told plainly, and they choose when to go — which
 * also lets them copy anything out first.
 *
 * ── Two pieces of state that look necessary and are not ───────────────────
 * "Expired" is derived, not stored: it is exactly `secondsLeft <= 0`, so keeping
 * a boolean in sync with a countdown would be two sources of truth for one fact.
 *
 * And the dismissal is stored AS the session it belongs to rather than as a
 * boolean that an effect resets when the session changes. Same behaviour, no
 * effect, no setState-during-effect cascade — and it cannot get stuck dismissed
 * across a re-sign-in, which the boolean version could if the reset ever missed.
 *
 * There are no passwords in this product, so "signing in again" means requesting
 * a new one-time code; the copy says so rather than implying a password prompt.
 */
export function SessionExpiry() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const secondsLeft = useCountdown(session?.expiresAt);

  if (!session) return null;

  const expired = secondsLeft <= 0;
  const dismissed = dismissedFor === session.issuedAt;
  const warning = !expired && !dismissed && secondsLeft <= WARN_WITHIN_SECONDS;

  const signInAgain = () => {
    void signOut().then(async () => {
      toast.info('Signed out', 'Request a new code to sign back in.');
      await navigate('/auth/sign-in', { replace: true });
    });
  };

  return (
    <>
      {warning && (
        <div className="fixed inset-x-0 bottom-0 z-50 p-4 sm:left-auto sm:max-w-sm">
          <Alert variant="warning" title="Your session is about to end">
            <p>
              You will be signed out in{' '}
              <span className="font-medium tabular-nums text-foreground">
                {formatCountdown(secondsLeft)}
              </span>
              . Save anything in progress.
            </p>
            <button
              type="button"
              onClick={() => {
                setDismissedFor(session.issuedAt);
              }}
              className="focus-ring mt-2 rounded text-xs font-medium text-foreground underline underline-offset-4"
            >
              Dismiss
            </button>
          </Alert>
        </div>
      )}

      <Dialog
        open={expired}
        // Not dismissible: the session really has ended, and offering a way to
        // carry on would be a lie. The only honest exit is to sign in again.
        dismissible={false}
        onClose={() => undefined}
        title="Your session has ended"
        description="Sessions last 8 hours. Anything unsaved is still on the page behind this — copy it out before you sign in again if you need to."
        size="sm"
        footer={
          <Button className="w-full sm:w-auto" onClick={signInAgain}>
            Sign in again
          </Button>
        }
      >
        <p className="py-2 text-sm text-muted-foreground">
          Signing in sends a new one-time code — there is no password to remember.
        </p>
      </Dialog>
    </>
  );
}
