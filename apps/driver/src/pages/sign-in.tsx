import { isAustralianMobile, OTP_CODE_LENGTH } from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  PinInput,
  Spinner,
} from '@plastago/ui';
import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';

/**
 * Driver sign-in — SMS one-time code (§9 A2).
 *
 * ── One screen, two steps ─────────────────────────────────────────────────
 * The web app splits the identifier and the code across two routes because the
 * office may open several tabs and needs a bookmarkable state. A driver does not:
 * they are on a phone, in one hand, and a navigation between steps is a chance to
 * lose the keyboard, the challenge, or their place. So the step is local state.
 *
 * ── There are no passwords in this product ────────────────────────────────
 * Which matters most here: a shared truck, a cracked screen, gloves, and a
 * password nobody can type is exactly how drivers end up sharing one login.
 */
export function SignInPage() {
  const { status, challenge, requestCode, resendCode, verifyCode } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Session first, challenge second — and in that order deliberately. A
   * successful verification SPENDS the challenge, so "no challenge" is true both
   * before you start and immediately after you succeed. Checking the challenge
   * first is what made the web app bounce back to sign-in after a correct code.
   */
  if (status === 'authenticated') {
    return <Navigate to={from ?? '/'} replace />;
  }

  const sendCode = async () => {
    if (!isAustralianMobile(mobile)) {
      setError('Enter your mobile as 04xx xxx xxx.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await requestCode(mobile);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message === 'UNKNOWN_MOBILE'
          ? 'We do not have that number on file. Ring the office on 1300 395 438 and they will add it.'
          : 'We could not send the code. Check your signal and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await verifyCode(value);
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : '';
      setError(
        reason === 'CODE_EXPIRED'
          ? 'That code has expired. Tap resend for a new one.'
          : reason === 'CHALLENGE_LOST'
            ? 'That sign-in attempt has expired. Start again.'
            : 'That code is not right. Check the text and try again.',
      );
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    try {
      await resendCode();
      setCode('');
    } catch {
      setError('We could not resend the code. Check your signal.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{challenge ? 'Enter your code' : 'Sign in'}</CardTitle>
        <CardDescription>
          {challenge
            ? `We texted a ${String(OTP_CODE_LENGTH)}-digit code to ${challenge.sentTo}.`
            : 'We’ll text you a code. No password to remember.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {error !== null && (
          <Alert variant="destructive" title="Could not sign you in">
            {error}
          </Alert>
        )}

        {challenge === null ? (
          <>
            <Field
              id="driver-mobile"
              label="Your mobile number"
              hint="The number the office has for you."
            >
              {(control) => (
                <Input
                  {...control}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  autoFocus
                  // Large text: this is tapped in sunlight, sometimes in gloves.
                  className="h-14 text-lg tracking-wide"
                  placeholder="0455 112 233"
                  value={mobile}
                  onChange={(event) => {
                    setMobile(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void sendCode();
                  }}
                />
              )}
            </Field>

            <Button
              size="lg"
              className="h-14 w-full text-base"
              disabled={busy}
              onClick={() => void sendCode()}
            >
              {busy && <Spinner label="Sending" />}
              Text me a code
            </Button>
          </>
        ) : (
          <>
            <PinInput
              label={`${String(OTP_CODE_LENGTH)}-digit code`}
              value={code}
              onChange={setCode}
              onComplete={(value) => {
                void submitCode(value);
              }}
              disabled={busy}
              invalid={error !== null}
              autoFocus
            />

            {busy && <Spinner label="Checking your code" />}

            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                className="focus-ring rounded text-sm text-muted-foreground underline-offset-4 hover:underline"
                onClick={() => void resend()}
                disabled={busy}
              >
                Resend the code
              </button>
              <a
                href="tel:1300395438"
                className="focus-ring rounded text-sm text-primary underline-offset-4 hover:underline"
              >
                Ring the office
              </a>
            </div>
          </>
        )}

        <p className="border-t border-border pt-4 text-xs text-muted-foreground">
          Demo build — sign in as <span className="font-mono">0455 112 233</span> with code{' '}
          <span className="font-mono">123456</span>.
        </p>
      </CardContent>
    </Card>
  );
}
