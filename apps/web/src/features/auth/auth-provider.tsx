import type { OtpChallenge, Session } from '@plastago/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ServiceError } from '@/services/service-error';
import { useServices } from '@/services/services-context';
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context';
import { can, type Capability } from './permissions';

/**
 * Session state for every surface in this app.
 *
 * Plain `useState` rather than TanStack Query, deliberately. The session is not
 * cached server data that a screen renders — it is the precondition for routing,
 * and route guards need to read it synchronously during render. Putting it in
 * the query cache adds an invalidation dance for no benefit, and makes
 * "am I signed in?" answerable only after a subscription resolves.
 *
 * The in-flight OTP challenge also lives here, not in the verify screen's local
 * state. Two reasons: a page reload on `/auth/verify` must not leave a dead
 * screen with no challenge to verify against, and "resend" belongs to the
 * challenge rather than to whichever component happens to be mounted.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { auth } = useServices();

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [identifier, setIdentifier] = useState<string | null>(null);

  /*
   * Session bootstrap.
   *
   * The `cancelled` flag is the whole guard, and it has to be the whole guard.
   * An earlier version also held a `bootstrapped` ref to avoid probing twice
   * under StrictMode — which deadlocked the app in development: StrictMode
   * unmounts and remounts, so the cleanup cancelled the first probe while the
   * ref made the second one bail out, and `status` stayed `loading` forever.
   * Every guarded route sat on its spinner.
   *
   * Two probes in development is the correct trade. A duplicated read is
   * harmless; a session that never resolves is not.
   */
  useEffect(() => {
    let cancelled = false;

    void auth
      .getSession()
      .then((result) => {
        if (cancelled) return;
        setSession(result);
        setStatus(result ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        // A failed session probe means "not signed in" as far as the UI is
        // concerned. Surfacing an error here would block the sign-in screen —
        // the one page that could actually fix the situation.
        if (cancelled) return;
        setSession(null);
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, [auth]);

  const requestCode = useCallback(
    async (value: string) => {
      const issued = await auth.requestCode({ identifier: value });
      setChallenge(issued);
      setIdentifier(value);
      return issued;
    },
    [auth],
  );

  const resendCode = useCallback(async () => {
    if (!challenge) {
      throw new ServiceError('CHALLENGE_NOT_FOUND', 'No challenge in progress');
    }
    const reissued = await auth.resendCode(challenge.challengeId);
    setChallenge(reissued);
    return reissued;
  }, [auth, challenge]);

  const verifyCode = useCallback(
    async (code: string) => {
      if (!challenge) {
        throw new ServiceError('CHALLENGE_NOT_FOUND', 'No challenge in progress');
      }

      const issued = await auth.verifyCode({ challengeId: challenge.challengeId, code });
      setSession(issued);
      setStatus('authenticated');
      setChallenge(null);
      setIdentifier(null);
      return issued;
    },
    [auth, challenge],
  );

  const signOut = useCallback(async () => {
    await auth.signOut();
    setSession(null);
    setStatus('anonymous');
    setChallenge(null);
    setIdentifier(null);
  }, [auth]);

  const abandonChallenge = useCallback(() => {
    setChallenge(null);
    setIdentifier(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const user = session?.user ?? null;

    return {
      status,
      session,
      user,
      challenge,
      identifier,
      requestCode,
      resendCode,
      verifyCode,
      signOut,
      abandonChallenge,
      can: (capability: Capability) => (user ? can(user.role, capability) : false),
    };
  }, [
    status,
    session,
    challenge,
    identifier,
    requestCode,
    resendCode,
    verifyCode,
    signOut,
    abandonChallenge,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
