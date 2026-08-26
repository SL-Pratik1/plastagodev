import {
  channelForIdentifier,
  looksLikeEmail,
  normaliseMobile,
  OTP_CODE_LENGTH,
  SessionSchema,
  type OtpChallenge,
  type OtpRequest,
  type OtpVerify,
  type Session,
} from '@plastago/shared';
import { ServiceError } from '../service-error.js';
import type { AuthService } from '../types.js';
import {
  clearStored,
  latency,
  maskEmail,
  maskMobile,
  MOCK_SESSION_KEY,
  readStored,
  writeStored,
} from './mock-transport.js';
import {
  DEMO_OTP_CODE,
  findIdentityByEmail,
  findIdentityByMobile,
  type DemoIdentity,
} from './fixtures/identities.js';

/**
 * In-memory authentication, standing in for the OTP endpoints (§9).
 *
 * It models the failure paths, not just the happy one, because those are what
 * the screens have to handle and what a demo gets asked about: an identifier
 * nobody recognises, a wrong code, an expired code, one attempt left, a resend
 * pressed too early. Each is reachable from the UI without editing code.
 *
 * ⚠️ There is no security here and none is implied. This decides what the
 * interface looks like; the server decides who gets in.
 */

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

interface PendingChallenge {
  challengeId: string;
  identity: DemoIdentity;
  channel: 'email' | 'sms';
  sentTo: string;
  expiresAt: number;
  resendAvailableAt: number;
  attemptsRemaining: number;
}

/** Module-scoped: a page reload legitimately abandons an in-flight challenge. */
const challenges = new Map<string, PendingChallenge>();
let challengeCounter = 0;

function toChallenge(pending: PendingChallenge): OtpChallenge {
  return {
    challengeId: pending.challengeId,
    channel: pending.channel,
    sentTo: pending.sentTo,
    expiresAt: new Date(pending.expiresAt).toISOString(),
    resendAvailableAt: new Date(pending.resendAvailableAt).toISOString(),
    attemptsRemaining: pending.attemptsRemaining,
  };
}

function resolveIdentity(identifier: string): DemoIdentity {
  const identity = looksLikeEmail(identifier)
    ? findIdentityByEmail(identifier)
    : findIdentityByMobile(normaliseMobile(identifier));

  if (!identity) {
    // The real server should answer identically whether or not the identifier
    // exists, or the form becomes a way to enumerate staff and customers. The
    // mock is explicit so the "we don't recognise this" screen can be built and
    // shown; see the note on that screen for how it should behave in production.
    throw new ServiceError('IDENTIFIER_UNKNOWN', `No demo identity for "${identifier}"`);
  }

  return identity;
}

function issueChallenge(identity: DemoIdentity, identifier: string): PendingChallenge {
  const channel = channelForIdentifier(identifier);
  const now = Date.now();
  challengeCounter += 1;

  const pending: PendingChallenge = {
    challengeId: `mock-challenge-${String(challengeCounter)}`,
    identity,
    channel,
    sentTo:
      channel === 'email'
        ? maskEmail(identity.email ?? identifier)
        : maskMobile(identity.mobile ?? normaliseMobile(identifier)),
    expiresAt: now + CODE_TTL_MS,
    resendAvailableAt: now + RESEND_COOLDOWN_MS,
    attemptsRemaining: MAX_ATTEMPTS,
  };

  challenges.set(pending.challengeId, pending);
  return pending;
}

function requireChallenge(challengeId: string): PendingChallenge {
  const pending = challenges.get(challengeId);
  if (!pending) {
    throw new ServiceError('CHALLENGE_NOT_FOUND', `Unknown challenge ${challengeId}`);
  }
  return pending;
}

function startSession(identity: DemoIdentity): Session {
  const now = Date.now();
  const { hint: _hint, ...user } = identity;

  const session: Session = {
    user: { ...user, lastSignedInAt: new Date(now).toISOString() },
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };

  writeStored(MOCK_SESSION_KEY, session);
  return session;
}

export function createMockAuthService(): AuthService {
  return {
    async getSession() {
      await latency(120, 80);

      const stored = readStored<unknown>(MOCK_SESSION_KEY);
      if (stored === null) return null;

      // Parsed, not cast. A stale shape in storage from an earlier build would
      // otherwise crash a component far from here — the same discipline the real
      // api client applies to responses.
      const parsed = SessionSchema.safeParse(stored);
      if (!parsed.success) {
        clearStored(MOCK_SESSION_KEY);
        return null;
      }

      if (new Date(parsed.data.expiresAt).getTime() <= Date.now()) {
        clearStored(MOCK_SESSION_KEY);
        return null;
      }

      return parsed.data;
    },

    async requestCode({ identifier }: OtpRequest) {
      await latency();
      const identity = resolveIdentity(identifier);
      return toChallenge(issueChallenge(identity, identifier));
    },

    async resendCode(challengeId: string) {
      await latency();
      const pending = requireChallenge(challengeId);

      if (Date.now() < pending.resendAvailableAt) {
        throw new ServiceError('RESEND_TOO_SOON', 'Resend requested before the cooldown elapsed');
      }

      const now = Date.now();
      pending.expiresAt = now + CODE_TTL_MS;
      pending.resendAvailableAt = now + RESEND_COOLDOWN_MS;
      pending.attemptsRemaining = MAX_ATTEMPTS;

      return toChallenge(pending);
    },

    async verifyCode({ challengeId, code }: OtpVerify) {
      await latency();
      const pending = requireChallenge(challengeId);

      if (Date.now() > pending.expiresAt) {
        throw new ServiceError('CODE_EXPIRED', 'Code expired');
      }

      if (code.length !== OTP_CODE_LENGTH || code !== DEMO_OTP_CODE) {
        pending.attemptsRemaining -= 1;

        if (pending.attemptsRemaining <= 0) {
          challenges.delete(challengeId);
          throw new ServiceError('CODE_ATTEMPTS_EXCEEDED', 'Too many incorrect attempts');
        }

        throw new ServiceError('CODE_INCORRECT', 'Incorrect code', {
          // Carried on the error so the screen can say "2 attempts remaining"
          // without a second round trip.
          fieldErrors: { attemptsRemaining: String(pending.attemptsRemaining) },
        });
      }

      challenges.delete(challengeId);
      return startSession(pending.identity);
    },

    async signOut() {
      await latency(160, 100);
      challenges.clear();
      clearStored(MOCK_SESSION_KEY);
    },
  };
}
