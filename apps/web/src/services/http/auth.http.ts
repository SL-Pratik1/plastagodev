import type { ApiClient } from '@plastago/api-client';
import {
  API_PREFIX,
  OtpChallengeSchema,
  SessionSchema,
  type OtpRequest,
  type OtpVerify,
} from '@plastago/shared';
import * as z from 'zod';
import type { AuthService } from '../types.js';
import { viaService } from './to-service-error.js';

/**
 * Authentication over HTTP (§9) — the real implementation of `AuthService`.
 *
 * The endpoint paths appear HERE and nowhere else in the app, which is the
 * whole point of the seam described in `services/README.md`: no screen, hook or
 * query knows a URL exists.
 *
 * The session itself is an httpOnly cookie set by the API, so there is no token
 * to store, read or attach — `credentials: 'include'` in the api client is the
 * only reason these calls are authenticated at all. Nothing here touches
 * `localStorage`, deliberately: a token the browser can read is a token an
 * injected script can read.
 */
export function createHttpAuthService(api: ApiClient): AuthService {
  const base = `${API_PREFIX}/auth`;

  return {
    getSession: () =>
      viaService(() =>
        api.request(`${base}/session`, {
          // `null` is a valid 200 body — "nobody is signed in" is not an error.
          schema: SessionSchema.nullable(),
        }),
      ),

    requestCode: (input: OtpRequest) =>
      viaService(() =>
        api.request(`${base}/otp/request`, {
          method: 'POST',
          body: input,
          schema: OtpChallengeSchema,
        }),
      ),

    resendCode: (challengeId: string) =>
      viaService(() =>
        api.request(`${base}/otp/resend`, {
          method: 'POST',
          // The interface takes a bare string; the wire needs an object.
          body: { challengeId },
          schema: OtpChallengeSchema,
        }),
      ),

    verifyCode: (input: OtpVerify) =>
      viaService(() =>
        api.request(`${base}/otp/verify`, {
          method: 'POST',
          body: input,
          schema: SessionSchema,
        }),
      ),

    /*
     * The switch is a WRITE, which is the whole point of it being here.
     *
     * It used to be a `setState` in the auth provider, and that could not
     * survive the one journey it exists for: the console and the driver app are
     * separate origins (§6A.5), so moving between them is a page load, and a
     * page load takes React state with it. The server now holds the answer, so
     * whichever origin loads next reads the same one.
     */
    setActiveRole: (role) =>
      viaService(() =>
        api.request(`${base}/active-role`, {
          method: 'POST',
          body: { role },
          schema: SessionSchema,
        }),
      ),

    signOut: async () => {
      await viaService(() =>
        api.request(`${base}/sign-out`, {
          method: 'POST',
          // 204: the api client yields `null` for an empty body, so that is
          // what the schema has to accept.
          schema: z.null(),
        }),
      );
    },
  };
}
