import type { AuthenticatedUser, OtpChallenge } from '@plastago/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useServices } from '@/services/services-context-value';
import { AuthContext, type AuthStatus } from './auth-context';

/**
 * Session state for the driver app.
 *
 * ── Why the session is probed once and then trusted ───────────────────────
 * A driver's shift is long and they are frequently out of coverage. Re-probing
 * on every navigation would mean a spinner every time they open a job in a dead
 * zone — so the session is resolved once at boot and held. The 14-hour expiry in
 * the mock is deliberate for the same reason: a re-authentication prompt on a
 * building site is the worst possible interruption.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { auth } = useServices();

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);

  useEffect(() => {
    let cancelled = false;

    void auth
      .getSession()
      .then((session) => {
        if (cancelled) return;
        setUser(session?.user ?? null);
        setStatus(session ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, [auth]);

  const requestCode = useCallback(
    async (mobile: string) => {
      const next = await auth.requestCode({ identifier: mobile });
      setChallenge(next);
      return next;
    },
    [auth],
  );

  const resendCode = useCallback(async () => {
    if (!challenge) throw new Error('CHALLENGE_LOST');
    const next = await auth.resendCode(challenge.challengeId);
    setChallenge(next);
    return next;
  }, [auth, challenge]);

  const verifyCode = useCallback(
    async (code: string) => {
      if (!challenge) throw new Error('CHALLENGE_LOST');
      const session = await auth.verifyCode({ challengeId: challenge.challengeId, code });
      setUser(session.user);
      setStatus('authenticated');
      // Cleared last: a spent challenge must not be readable as "never had one",
      // which is the bug that made the web app's OTP screen bounce back to
      // sign-in after a successful verification.
      setChallenge(null);
      return session;
    },
    [auth, challenge],
  );

  const signOut = useCallback(async () => {
    await auth.signOut();
    setUser(null);
    setChallenge(null);
    setStatus('anonymous');
  }, [auth]);

  const value = useMemo(
    () => ({ status, user, challenge, requestCode, resendCode, verifyCode, signOut }),
    [status, user, challenge, requestCode, resendCode, verifyCode, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
