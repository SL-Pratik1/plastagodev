import type { AuthenticatedUser, OtpChallenge, Session } from '@plastago/shared';
import { createContext, useContext } from 'react';
import type { Capability } from './permissions';

/**
 * `loading` is a first-class state, not a boolean flag.
 *
 * On a hard refresh the app does not yet know whether there is a session. If
 * that moment is modelled as "not signed in", every guard redirects to the
 * sign-in screen and the user is bounced out of the page they reloaded. So the
 * three states are distinct and guards must handle all three.
 */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

export interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  user: AuthenticatedUser | null;

  /** The in-flight OTP challenge, held so the verify screen has its context. */
  challenge: OtpChallenge | null;
  /** What the user typed, so the verify screen can offer "use a different one". */
  identifier: string | null;

  requestCode: (identifier: string) => Promise<OtpChallenge>;
  resendCode: () => Promise<OtpChallenge>;
  verifyCode: (code: string) => Promise<Session>;
  signOut: () => Promise<void>;
  abandonChallenge: () => void;

  /** Capability check for the signed-in user. False when anonymous. */
  can: (capability: Capability) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/**
 * The signed-in user, for components that live behind a guard.
 *
 * Throwing rather than returning `null` is the point: inside `<RequireAuth>` a
 * user is guaranteed, so this removes a null check from every consumer. If it
 * ever throws, the component is mounted outside the guard — which is a routing
 * bug worth failing loudly on rather than rendering an empty header.
 */
export function useCurrentUser(): AuthenticatedUser {
  const { user } = useAuth();
  if (!user) {
    throw new Error('useCurrentUser requires an authenticated route — check the router guards');
  }
  return user;
}
