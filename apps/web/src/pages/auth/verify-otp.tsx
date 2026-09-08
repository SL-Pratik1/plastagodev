import { OTP_CODE_LENGTH, ROLE_LABELS } from '@plastago/shared';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PinInput,
  Spinner,
  useToast,
} from '@plastago/ui';
import { ArrowLeftIcon } from 'lucide-react';
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { formatCountdown, useCountdown } from '@/lib/use-countdown';
import { useAuth } from '@/features/auth/auth-context';
import { codeSentHint, codeSentMessage, describeAuthError } from '@/features/auth/auth-messages';
import { signInDestination } from '@/features/auth/route-access';

/**
 * Step 2 of 2 — enter the code.
 *
 * The behaviours here are the ones that decide whether OTP feels slick or
 * tedious, and none of them are visible in a screenshot:
 *
 *  • **Auto-submit on the sixth digit.** Nobody wants to type a code and then
 *    hunt for a button.
 *  • **A visible expiry countdown.** A code that dies silently reads as "I typed
 *    it wrong" and sends the user round the loop again.
 *  • **Resend disabled with the wait shown**, not disabled mysteriously.
 *  • **The code is cleared and refocused after a wrong attempt**, so the next
 *    try starts from an empty field rather than needing six backspaces.
 *  • **"Use a different email or mobile"** — a typo one screen back must not
 *    require a browser Back press.
 *
 * Reloading this page has no challenge to verify against, so it redirects to the
 * start rather than rendering a form that cannot work.
 */
export function VerifyOtpPage() {
  const { challenge, identifier, status, user, verifyCode, resendCode, abandonChallenge } =
    useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mustRestart, setMustRestart] = useState(false);

  const expiresIn = useCountdown(challenge?.expiresAt);
  const resendIn = useCountdown(challenge?.resendAvailableAt);

  const from = (location.state as { from?: string } | null)?.from;

  /*
   * ── Why this guard checks the SESSION before the challenge ───────────────
   * A successful verification clears the in-flight challenge — it has been
   * spent. So "no challenge" is true in two completely different situations,
   * and they need opposite outcomes:
   *
   *   • never had one (direct visit, or a reload)  → back to sign-in
   *   • just succeeded                             → on to the landing page
   *
   * An earlier version only tested the challenge, so a successful sign-in
   * redirected straight back to the sign-in screen. The user *was* authenticated
   * — they were just looking at the login form, which reads as "the OTP did
   * nothing". Checking `status` first is what separates the two cases.
   */
  if (status === 'authenticated' && user) {
    return <Navigate to={signInDestination(user.role, from)} replace />;
  }

  if (!challenge) return <Navigate to="/auth/sign-in" replace />;

  const expired = expiresIn <= 0;

  const submit = async (value: string) => {
    if (value.length !== OTP_CODE_LENGTH || verifying) return;

    setVerifying(true);
    setError(null);

    try {
      const session = await verifyCode(value);
      const destination = signInDestination(session.user.role, from);

      toast.success(
        `Signed in as ${session.user.name}`,
        `${ROLE_LABELS[session.user.role]} · all times Australia/Sydney`,
      );

      await navigate(destination, { replace: true });
    } catch (caught) {
      const described = describeAuthError(caught);
      setError(described.message);
      setMustRestart(described.restart ?? false);
      // Clear so the next attempt starts clean, not six backspaces from here.
      setCode('');
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);

    try {
      const reissued = await resendCode();
      setCode('');
      // A toast here IS warranted: the new code arrives out of band, and nothing
      // else on screen changes to confirm the button did anything.
      toast.success('New code sent', codeSentMessage(reissued.channel, reissued.sentTo));
    } catch (caught) {
      const described = describeAuthError(caught);
      setError(described.message);
      setMustRestart(described.restart ?? false);
    } finally {
      setResending(false);
    }
  };

  const startOver = () => {
    abandonChallenge();
    void navigate('/auth/sign-in', { replace: true, state: from ? { from } : null });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Enter your code</CardTitle>
          <CardDescription>
            {codeSentMessage(challenge.channel, challenge.sentTo)}.{' '}
            {codeSentHint(challenge.channel)}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="space-y-2">
            <PinInput
              label={`${String(OTP_CODE_LENGTH)}-digit code`}
              value={code}
              onChange={setCode}
              onComplete={(value) => {
                void submit(value);
              }}
              disabled={verifying || expired || mustRestart}
              invalid={Boolean(error)}
              autoFocus
              describedBy={error ? 'otp-error' : 'otp-expiry'}
            />

            {error ? (
              <p id="otp-error" role="alert" className="text-xs font-medium text-destructive">
                {error}
              </p>
            ) : (
              <p id="otp-expiry" className="text-xs text-muted-foreground" aria-live="polite">
                {expired ? (
                  <span className="font-medium text-warning">
                    This code has expired — send a new one.
                  </span>
                ) : (
                  <>
                    Expires in{' '}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCountdown(expiresIn)}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>

          {mustRestart ? (
            <Button type="button" size="lg" className="w-full" onClick={startOver}>
              Start again
            </Button>
          ) : (
            <Button
              type="button"
              size="lg"
              className="w-full"
              disabled={code.length !== OTP_CODE_LENGTH || verifying || expired}
              onClick={() => {
                void submit(code);
              }}
            >
              {verifying ? (
                <>
                  <Spinner className="text-current" label="Verifying your code" />
                  Verifying…
                </>
              ) : (
                'Verify and sign in'
              )}
            </Button>
          )}

          <div className="flex flex-col gap-3 border-t border-border pt-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => void resend()}
              disabled={resending || resendIn > 0}
              className="focus-ring rounded text-left font-medium text-primary underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            >
              {resending
                ? 'Sending…'
                : resendIn > 0
                  ? `Resend code in ${String(resendIn)}s`
                  : 'Resend code'}
            </button>

            <button
              type="button"
              onClick={startOver}
              className="focus-ring flex items-center gap-1.5 rounded text-left text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <ArrowLeftIcon aria-hidden className="size-3.5" />
              Use a different {challenge.channel === 'sms' ? 'number' : 'email'}
            </button>
          </div>

          {identifier && (
            <p className="text-xs text-muted-foreground">
              Signing in as <span className="font-medium text-foreground">{identifier}</span>
            </p>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
