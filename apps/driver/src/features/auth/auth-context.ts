import type { AuthenticatedUser, OtpChallenge, Session } from '@plastago/shared';
import { createContext, useContext } from 'react';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthenticatedUser | null;
  /** The in-flight OTP challenge. Cleared once it has been spent. */
  challenge: OtpChallenge | null;
  requestCode: (mobile: string) => Promise<OtpChallenge>;
  resendCode: () => Promise<OtpChallenge>;
  verifyCode: (code: string) => Promise<Session>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

export function useDriver(): AuthenticatedUser {
  const { user } = useAuth();
  if (!user) throw new Error('useDriver requires a signed-in route — check the guard');
  return user;
}
