import {
  channelForIdentifier,
  normaliseMobile,
  type AuthChannel,
  type AuthenticatedUser,
  type OtpChallenge,
  type OtpRequest,
  type OtpVerify,
  type Session,
} from '@plastago/shared';
import { getAuth } from '../../auth/better-auth.js';
import { takeOtpCode } from '../../auth/otp-peek.js';
import { env, revealUnknownIdentifier } from '../../config/env.js';
import { AppError, isAppError } from '../../lib/app-error.js';
import { authError } from '../../lib/auth-error.js';
import { logger } from '../../lib/logger.js';
import { maskIdentifier } from '../../lib/mask-identifier.js';
import { userRepository } from '../users/user.repository.js';
import { authRepository, type ChallengeRecord, type UserRecord } from './auth.repository.js';

const log = logger.child({ module: 'auth-service' });

/**
 * Everything the service needs from the request without importing Express.
 *
 * `headers` is a standard `Headers`, which is also what Better Auth's
 * server-side API expects — so the controller converts once and neither this
 * file nor Better Auth ever sees an Express object.
 */
export interface RequestContext {
  ip: string | null;
  headers: Headers;
}

/** A verified sign-in: the session for the body, the cookies for the response. */
export interface SignInResult {
  session: Session;
  setCookie: string[];
}

/**
 * Authentication (§9, M1.5) — business rules only. No Express, no Mongoose.
 *
 * ── The shape of the flow, and why it is a challenge ────────────────────────
 * `requestCode` issues an opaque `challengeId` and holds the identifier
 * server-side; `verifyCode` sends back only that id and the six digits. The
 * browser never repeats the email or mobile, so a code cannot be verified
 * against an identifier it was not issued for, and the identifier does not
 * linger in page state or in an error report.
 *
 * ── What is deliberately indistinguishable ─────────────────────────────────
 * In production an unrecognised identifier gets a normal-looking challenge and
 * no message (a "decoy"). The sign-in form is on the public internet for the
 * customer portal, and "does this address have an account here" is the first
 * question asked before a phishing run against a builder's staff. Development
 * reveals it instead, so the "we don't recognise that" screen stays walkable —
 * `revealUnknownIdentifier` is forced off in production regardless of config.
 */
export const authService = {
  /** POST /auth/otp/request */
  async requestCode({ identifier }: OtpRequest, ctx: RequestContext): Promise<OtpChallenge> {
    const channel = channelForIdentifier(identifier);
    const normalised = normaliseIdentifier(identifier, channel);

    await assertSendAllowed(normalised);

    const user = await resolveUser(normalised, channel);

    // Both "no such person" and "suspended" take the same branch: in production
    // neither may be admitted to, and a decoy is what makes them identical to a
    // successful send from the outside.
    if (!user) {
      if (revealUnknownIdentifier) {
        throw authError('IDENTIFIER_UNKNOWN', `No user matches "${normalised}"`);
      }
      return issueDecoy(normalised, channel, ctx);
    }

    if (user.status === 'suspended') {
      log.warn({ userId: user.id }, 'sign-in attempt on a suspended account');
      if (revealUnknownIdentifier) {
        throw authError('ACCOUNT_SUSPENDED', 'Account is suspended');
      }
      return issueDecoy(normalised, channel, ctx);
    }

    await sendCode(normalised, channel);

    const now = new Date();
    const challenge = await authRepository.createChallenge({
      channel,
      identifier: normalised,
      userId: user.id,
      sentTo: mask(normalised, channel),
      ...windowFrom(now),
      attemptsRemaining: env.OTP_MAX_ATTEMPTS,
      decoy: false,
      requestIp: ctx.ip,
      purgeAt: purgeFrom(now),
    });

    log.info({ userId: user.id, channel, challengeId: challenge.challengeId }, 'code sent');
    return toOtpChallenge(challenge, takeOtpCode(normalised));
  },

  /** POST /auth/otp/resend */
  async resendCode(challengeId: string, ctx: RequestContext): Promise<OtpChallenge> {
    const existing = await requireLiveChallenge(challengeId);

    if (Date.now() < existing.resendAvailableAt.getTime()) {
      throw authError('RESEND_TOO_SOON', 'Resend requested before the cooldown elapsed');
    }

    // A resend is a send: it costs an SMS and reaches a real phone, so it is
    // subject to the same per-identifier ceiling.
    if (!existing.decoy) {
      await assertSendAllowed(existing.identifier);
      await sendCode(existing.identifier, existing.channel);
    }

    const now = new Date();
    const window = windowFrom(now);
    await authRepository.refreshChallenge(challengeId, {
      ...window,
      attemptsRemaining: env.OTP_MAX_ATTEMPTS,
      purgeAt: purgeFrom(now),
      requestIp: ctx.ip,
    });

    log.info({ challengeId, channel: existing.channel }, 'code resent');

    return toOtpChallenge(
      {
        ...existing,
        ...window,
        attemptsRemaining: env.OTP_MAX_ATTEMPTS,
      },
      // A decoy never sent anything, so there is nothing to reveal.
      existing.decoy ? null : takeOtpCode(existing.identifier),
    );
  },

  /** POST /auth/otp/verify */
  async verifyCode({ challengeId, code }: OtpVerify, ctx: RequestContext): Promise<SignInResult> {
    const challenge = await requireLiveChallenge(challengeId);

    // Expiry is checked before an attempt is spent: a code that has run out of
    // time is not a wrong guess, and the screen says something different about
    // each ("send a new one" vs "check the digits").
    if (Date.now() > challenge.expiresAt.getTime()) {
      await noteSignIn(challenge, 'expired-code', ctx);
      throw authError('CODE_EXPIRED', 'Code expired');
    }

    const remaining = await authRepository.spendAttempt(challengeId);
    if (remaining === null) {
      await noteSignIn(challenge, 'locked-out', ctx);
      throw authError('CODE_ATTEMPTS_EXCEEDED', 'No attempts remaining');
    }

    // A decoy has no user and no code on file. It burns attempts exactly like a
    // real challenge so that timing and responses stay uninformative.
    if (challenge.decoy || !challenge.userId) {
      await noteSignIn(challenge, 'failed-code', ctx);
      throw wrongCode(remaining);
    }

    const verified = await verifyWithProvider(challenge, code, ctx);
    if (!verified) {
      await noteSignIn(challenge, 'failed-code', ctx);
      throw wrongCode(remaining);
    }

    // Flip the challenge to consumed and let ONLY the caller that won that flip
    // continue. Two verifications arriving together must not mint two sessions.
    const claimed = await authRepository.consumeChallenge(challengeId, new Date());
    if (!claimed) {
      throw authError('CHALLENGE_NOT_FOUND', 'Challenge was already used');
    }

    const user = await authRepository.findUserById(challenge.userId);
    if (!user) {
      // The account was deleted between the code being sent and verified.
      throw authError('IDENTIFIER_UNKNOWN', 'User no longer exists');
    }
    if (user.status === 'suspended') {
      throw authError('ACCOUNT_SUSPENDED', 'Account is suspended');
    }

    const signedInAt = new Date();
    await authRepository.markSignedIn(user.id, signedInAt);
    await noteSignIn(challenge, 'success', ctx);

    log.info({ userId: user.id, role: user.role, channel: challenge.channel }, 'signed in');

    return {
      session: buildSession({ ...user, lastSignedInAt: signedInAt.toISOString() }, signedInAt),
      setCookie: verified.setCookie,
    };
  },

  /**
   * GET /auth/session
   *
   * Returns `null` rather than throwing for "not signed in": the app asks this
   * on every load, and a 401 on the ordinary case of a first visit would be a
   * lie about something being wrong.
   */
  async getSession(ctx: RequestContext): Promise<Session | null> {
    const auth = getAuth();

    const result = await auth.api.getSession({ headers: ctx.headers });
    if (!result) return null;

    // Read our own record rather than trusting the session's copy: role and
    // status may have changed since sign-in, and a suspended user holding a
    // valid cookie must not keep working.
    const user = await authRepository.findUserById(result.user.id);
    if (!user || user.status === 'suspended') return null;

    return buildSession(user, new Date(result.session.createdAt), new Date(result.session.expiresAt));
  },

  /** POST /auth/sign-out */
  async signOut(ctx: RequestContext): Promise<string[]> {
    const auth = getAuth();

    try {
      const { headers } = await auth.api.signOut({
        headers: ctx.headers,
        returnHeaders: true,
      });
      return headers.getSetCookie();
    } catch (error) {
      // Signing out must always appear to succeed. If there was no session, the
      // caller has already got what they asked for.
      log.debug({ err: error }, 'sign-out on a request with no live session');
      return [];
    }
  },
};

// ── Internals ───────────────────────────────────────────────────────────────

function normaliseIdentifier(identifier: string, channel: AuthChannel): string {
  return channel === 'email' ? identifier.trim().toLowerCase() : normaliseMobile(identifier);
}

async function resolveUser(normalised: string, channel: AuthChannel): Promise<UserRecord | null> {
  return channel === 'email'
    ? authRepository.findUserByEmail(normalised)
    : authRepository.findUserByMobile(normalised);
}

/**
 * Records one sign-in attempt into `usersignins` — the per-user list on the
 * Users screen, "here are Priya's last 20 sign-ins", read while looking AT
 * Priya.
 *
 * ⚠️ FAILURES ARE RECORDED, and that is the point. A successful sign-in is
 * routine; six failed ones against a director's address at 2am is the thing
 * somebody needs to be able to find. `identifierMasked` keeps the list useful
 * without turning it into a list of everybody's email addresses.
 *
 * Never throws: a sign-in must not fail because its own history row could not
 * be written.
 */
async function noteSignIn(
  challenge: ChallengeRecord,
  outcome: 'success' | 'failed-code' | 'expired-code' | 'locked-out',
  ctx: RequestContext,
): Promise<void> {
  const device = ctx.headers.get('user-agent') ?? '';
  const masked = mask(challenge.identifier, challenge.channel);

  try {
    await userRepository.recordSignIn({
      userId: challenge.userId,
      identifierMasked: masked,
      channel: challenge.channel,
      outcome,
      device,
    });
  } catch (error) {
    log.error({ err: error, outcome }, 'could not record the sign-in attempt');
  }
}

/**
 * Moved to `lib/mask-identifier.ts` — the outbound message log masks recipients
 * the same way, and two copies would drift into two different shapes for the
 * same person.
 */
function mask(identifier: string, channel: AuthChannel): string {
  return maskIdentifier(identifier, channel);
}

function windowFrom(now: Date): { expiresAt: Date; resendAvailableAt: Date } {
  return {
    expiresAt: new Date(now.getTime() + env.OTP_TTL_SECONDS * 1000),
    resendAvailableAt: new Date(now.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000),
  };
}

/**
 * When the row may be deleted — an hour after the code dies.
 *
 * The gap is what keeps "expired" and "never existed" separable; see the
 * `purgeAt` note in `auth.model.ts`.
 */
function purgeFrom(now: Date): Date {
  return new Date(now.getTime() + env.OTP_TTL_SECONDS * 1000 + 60 * 60 * 1000);
}

function toOtpChallenge(
  challenge: {
    challengeId: string;
    channel: AuthChannel;
    sentTo: string;
    expiresAt: Date;
    resendAvailableAt: Date;
    attemptsRemaining: number;
  },
  /**
   * Passed only on the two paths that actually sent a code. A decoy has no code
   * to reveal, and must not be distinguishable from a real send by the presence
   * or absence of this field — so it is omitted on both.
   */
  devCode: string | null = null,
): OtpChallenge {
  return {
    challengeId: challenge.challengeId,
    channel: challenge.channel,
    sentTo: challenge.sentTo,
    expiresAt: challenge.expiresAt.toISOString(),
    resendAvailableAt: challenge.resendAvailableAt.toISOString(),
    attemptsRemaining: challenge.attemptsRemaining,
    ...(devCode === null ? {} : { devCode }),
  };
}

async function requireLiveChallenge(challengeId: string): Promise<ChallengeRecord> {
  const challenge = await authRepository.findChallenge(challengeId);

  // A spent challenge reads as gone, not as "wrong code": the screen's answer
  // is "start again", which is exactly right for both.
  if (!challenge || challenge.consumedAt) {
    throw authError('CHALLENGE_NOT_FOUND', `No live challenge ${challengeId}`);
  }
  return challenge;
}

function wrongCode(attemptsRemaining: number): AppError {
  if (attemptsRemaining <= 0) {
    return authError('CODE_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts');
  }
  // Carried so the screen can warn before the last attempt is spent, without a
  // second round trip — `auth-messages.ts` reads this exact key.
  return authError('CODE_INCORRECT', 'Incorrect code', {
    attemptsRemaining: String(attemptsRemaining),
  });
}

/** Per-identifier ceiling, independent of the IP-based limiter on the router. */
async function assertSendAllowed(identifier: string): Promise<void> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const sends = await authRepository.countRecentSends(identifier, since);

  if (sends >= env.OTP_MAX_SENDS_PER_HOUR) {
    log.warn({ identifier: identifier.slice(0, 3), sends }, 'per-identifier send limit hit');
    throw new AppError(429, 'RATE_LIMITED', 'Too many codes requested — try again later');
  }
}

/**
 * Hands the send to Better Auth, which generates and stores the code; the
 * plugin callbacks in `better-auth.ts` do the actual delivery.
 */
async function sendCode(identifier: string, channel: AuthChannel): Promise<void> {
  const auth = getAuth();

  try {
    if (channel === 'email') {
      await auth.api.sendVerificationOTP({ body: { email: identifier, type: 'sign-in' } });
    } else {
      await auth.api.sendPhoneNumberOTP({ body: { phoneNumber: identifier } });
    }
  } catch (error) {
    // A provider failure surfaced from the plugin callback is already the right
    // error — a 503 the client can retry — so let it through untouched.
    if (isAppError(error)) throw error;
    log.error({ err: error, channel }, 'could not issue a code');
    throw AppError.dependencyUnavailable('Could not send the code — try again');
  }
}

/**
 * Checks the code and, on success, returns the session cookies Better Auth
 * wants set. `null` means the code was wrong — never an exception, because a
 * wrong code is an expected outcome on this path, not a fault.
 */
async function verifyWithProvider(
  challenge: ChallengeRecord,
  code: string,
  ctx: RequestContext,
): Promise<{ setCookie: string[] } | null> {
  const auth = getAuth();

  try {
    const { headers } =
      challenge.channel === 'email'
        ? await auth.api.signInEmailOTP({
            body: { email: challenge.identifier, otp: code },
            headers: ctx.headers,
            returnHeaders: true,
          })
        : await auth.api.verifyPhoneNumber({
            body: { phoneNumber: challenge.identifier, code },
            headers: ctx.headers,
            returnHeaders: true,
          });

    return { setCookie: headers.getSetCookie() };
  } catch (error) {
    log.debug({ err: error, channel: challenge.channel }, 'code rejected');
    return null;
  }
}

function buildSession(user: UserRecord, issuedAt: Date, expiresAt?: Date): Session {
  /**
   * `role` must be a member of `roles` — the invariant stated on
   * `AuthenticatedUserSchema`: permission checks read the ACTIVE role, so an
   * active role the user does not actually hold is a privilege escalation, not
   * a display glitch.
   *
   * Enforced here because it cannot be enforced anywhere cheaper: MongoDB's
   * `$jsonSchema` can constrain each field's values but cannot express a
   * relationship between two of them, so there is no database-level guard
   * available. Failing closed is the only safe direction — a user who cannot
   * sign in raises a support call, where one signing in with a role they were
   * never granted raises nothing at all.
   */
  if (!user.roles.includes(user.role)) {
    log.error(
      { userId: user.id, role: user.role, roles: user.roles },
      'user record is inconsistent: the active role is not one this user holds — refusing sign-in',
    );
    throw AppError.forbidden('Your account is misconfigured — contact the office');
  }

  // `status` is intentionally dropped: it decided whether this session exists,
  // and the browser has no use for it on the session object.
  const { status: _status, ...authenticated } = user;

  return {
    user: authenticated satisfies AuthenticatedUser,
    issuedAt: issuedAt.toISOString(),
    expiresAt: (
      expiresAt ?? new Date(issuedAt.getTime() + env.AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000)
    ).toISOString(),
  };
}

/**
 * A challenge for an identifier that does not exist.
 *
 * Every field is shaped like a real one so the response is byte-comparable in
 * structure, and the cooldown and attempt count behave identically. Nothing is
 * sent, and verification can never succeed.
 */
async function issueDecoy(
  identifier: string,
  channel: AuthChannel,
  ctx: RequestContext,
): Promise<OtpChallenge> {
  const now = new Date();

  const challenge = await authRepository.createChallenge({
    channel,
    identifier,
    userId: null,
    sentTo: mask(identifier, channel),
    ...windowFrom(now),
    attemptsRemaining: env.OTP_MAX_ATTEMPTS,
    decoy: true,
    requestIp: ctx.ip,
    purgeAt: purgeFrom(now),
  });

  log.info({ channel, challengeId: challenge.challengeId }, 'decoy challenge issued');
  return toOtpChallenge(challenge);
}
