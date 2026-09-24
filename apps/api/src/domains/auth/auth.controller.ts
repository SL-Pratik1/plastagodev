import type { OtpRequestSchema, OtpVerifySchema } from '@plastago/shared';
import type { Request, Response } from 'express';
import type { ValidatedRequest } from '../../middleware/validate.js';
import { authService, type RequestContext } from './auth.service.js';
import type { ActiveRoleSchema, OtpResendSchema } from './auth.schemas.js';

/**
 * Controller layer — HTTP in, HTTP out. No business rules, no Mongoose.
 *
 * Handlers are arrow-function properties, not methods: Express receives them as
 * bare references, so a `this`-bound method would silently lose its receiver.
 */
export const authController = {
  requestCode: async (
    req: ValidatedRequest<{ body: typeof OtpRequestSchema }>,
    res: Response,
  ): Promise<void> => {
    const challenge = await authService.requestCode(req.validated.body, contextOf(req));
    res.status(201).json(challenge);
  },

  resendCode: async (
    req: ValidatedRequest<{ body: typeof OtpResendSchema }>,
    res: Response,
  ): Promise<void> => {
    const challenge = await authService.resendCode(
      req.validated.body.challengeId,
      contextOf(req),
    );
    res.status(201).json(challenge);
  },

  verifyCode: async (
    req: ValidatedRequest<{ body: typeof OtpVerifySchema }>,
    res: Response,
  ): Promise<void> => {
    const { session, setCookie } = await authService.verifyCode(
      req.validated.body,
      contextOf(req),
    );

    applySetCookie(res, setCookie);
    res.status(200).json(session);
  },

  /**
   * `null` is a legitimate answer with a 200, not a 401.
   *
   * The app calls this on every load; answering 401 to "nobody is signed in"
   * would put an error in the console and a failed request in the network tab
   * for the most ordinary state the application has.
   */
  getSession: async (req: Request, res: Response): Promise<void> => {
    const session = await authService.getSession(contextOf(req));
    res.status(200).json(session);
  },

  /**
   * Returns the whole session, not a 204.
   *
   * The caller's next act is to re-render the entire application around the new
   * role, and handing back the session it should render from removes the
   * round trip — and with it the flicker of a shell drawn from a role that has
   * just stopped being true.
   */
  setActiveRole: async (
    req: ValidatedRequest<{ body: typeof ActiveRoleSchema }>,
    res: Response,
  ): Promise<void> => {
    const session = await authService.setActiveRole(req.validated.body.role, contextOf(req));
    res.status(200).json(session);
  },

  signOut: async (req: Request, res: Response): Promise<void> => {
    const setCookie = await authService.signOut(contextOf(req));
    applySetCookie(res, setCookie);
    res.status(204).end();
  },
};

/**
 * Express request → the plain values the service accepts.
 *
 * Converting the headers to a standard `Headers` here is what keeps Express out
 * of the service and out of Better Auth's call sites. Array-valued headers are
 * appended rather than joined, because `cookie` can legitimately arrive more
 * than once and Better Auth has to see all of it.
 */
function contextOf(req: Request): RequestContext {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  return { ip: req.ip ?? null, headers };
}

/**
 * Forwards Better Auth's cookies onto our own response.
 *
 * `append`, not `set`: a sign-in issues both a session cookie and its signature
 * companion, and `set` would keep only the last of them.
 */
function applySetCookie(res: Response, cookies: readonly string[]): void {
  for (const cookie of cookies) {
    res.append('set-cookie', cookie);
  }
}
