import type { Role, UserStatus } from '@plastago/shared';
import type {
  ChallengeRecord,
  CreateChallengeInput,
  UserRecord,
} from '../../src/domains/auth/auth.repository.js';

/**
 * In-memory doubles for the auth service's two collaborators.
 *
 * ── Why fakes and not a live Mongo ─────────────────────────────────────────
 * The rules worth testing here are decision rules: which failure a wrong code
 * produces, whether an expired code spends an attempt, whether a decoy is
 * distinguishable from a real challenge, whether one code can open two
 * sessions. None of those are storage behaviour, and running them against a
 * real database would make them slow and order-dependent for no extra coverage.
 *
 * The repository's own Mongo semantics — the unique index on `email`, the
 * atomic `$inc`, the TTL on `purgeAt` — are integration concerns and belong in
 * a suite that has a replica set. That is deliberately not this file.
 */

export const VALID_CODE = '123456';

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  // Shaped like a real ObjectId so `ObjectIdSchema` accepts it in a route test.
  return idCounter.toString(16).padStart(24, '0');
}

export interface FakeUserInput {
  email?: string | null;
  mobile?: string | null;
  role?: Role;
  /** Everything they hold. Defaults to `[role]`. */
  roles?: Role[];
  status?: UserStatus;
}

export function createFakeRepository() {
  const users = new Map<string, UserRecord>();
  const challenges = new Map<string, ChallengeRecord>();
  const sendLog: string[] = [];
  const signedIn: Array<{ userId: string; at: Date }> = [];
  /** The role each SESSION chose to work as — see `setSessionActiveRole`. */
  const sessionRoles = new Map<string, Role | null>();

  function addUser(input: FakeUserInput = {}): UserRecord {
    const user: UserRecord = {
      id: nextId(),
      name: 'Test Person',
      email: input.email === undefined ? 'test@plastago.com.au' : input.email,
      mobile: input.mobile === undefined ? null : input.mobile,
      role: input.role ?? 'office-staff',
      /*
       * `roles` defaults to the single main role, but takes an override so a
       * test can build the one person this matters for: the allocator who also
       * drives (Matt, 27:01) and therefore has a role to switch to.
       */
      roles: input.roles ?? [input.role ?? 'office-staff'],
      status: input.status ?? 'active',
      jobTitle: 'Tester',
      brandIds: ['plastago'],
      accountId: null,
      lastSignedInAt: null,
    };
    users.set(user.id, user);
    return user;
  }

  const repository = {
    findUserByEmail: (email: string) =>
      Promise.resolve([...users.values()].find((u) => u.email === email.toLowerCase()) ?? null),

    findUserByMobile: (mobile: string) =>
      Promise.resolve([...users.values()].find((u) => u.mobile === mobile) ?? null),

    findUserById: (id: string) => Promise.resolve(users.get(id) ?? null),

    findSessionActiveRole: (sessionId: string) =>
      Promise.resolve(sessionRoles.get(sessionId) ?? null),

    setSessionActiveRole: (sessionId: string, role: Role | null) => {
      sessionRoles.set(sessionId, role);
      return Promise.resolve();
    },

    markSignedIn: (userId: string, at: Date) => {
      signedIn.push({ userId, at });
      const user = users.get(userId);
      if (user) users.set(userId, { ...user, lastSignedInAt: at.toISOString() });
      return Promise.resolve();
    },

    createChallenge: (input: CreateChallengeInput) => {
      const record: ChallengeRecord = {
        challengeId: nextId(),
        channel: input.channel,
        identifier: input.identifier,
        userId: input.userId,
        sentTo: input.sentTo,
        expiresAt: input.expiresAt,
        resendAvailableAt: input.resendAvailableAt,
        attemptsRemaining: input.attemptsRemaining,
        consumedAt: null,
        decoy: input.decoy,
      };
      challenges.set(record.challengeId, record);
      sendLog.push(input.identifier);
      return Promise.resolve(record);
    },

    findChallenge: (id: string) => Promise.resolve(challenges.get(id) ?? null),

    spendAttempt: (id: string) => {
      const found = challenges.get(id);
      if (!found || found.attemptsRemaining <= 0) return Promise.resolve(null);
      const updated = { ...found, attemptsRemaining: found.attemptsRemaining - 1 };
      challenges.set(id, updated);
      return Promise.resolve(updated.attemptsRemaining);
    },

    consumeChallenge: (id: string, at: Date) => {
      const found = challenges.get(id);
      // Mirrors the real `updateOne({ consumedAt: null })`: only the first wins.
      if (!found || found.consumedAt) return Promise.resolve(false);
      challenges.set(id, { ...found, consumedAt: at });
      return Promise.resolve(true);
    },

    refreshChallenge: (
      id: string,
      values: {
        expiresAt: Date;
        resendAvailableAt: Date;
        attemptsRemaining: number;
        purgeAt: Date;
        requestIp: string | null;
      },
    ) => {
      const found = challenges.get(id);
      if (found) {
        challenges.set(id, {
          ...found,
          expiresAt: values.expiresAt,
          resendAvailableAt: values.resendAvailableAt,
          attemptsRemaining: values.attemptsRemaining,
        });
      }
      return Promise.resolve();
    },

    countRecentSends: (identifier: string) =>
      Promise.resolve(sendLog.filter((sent) => sent === identifier).length),

    ensureSchemaValidators: () => Promise.resolve(),
    seedBrands: () => Promise.resolve(),
    brandsExist: () => Promise.resolve(true),
    createIndexes: () => Promise.resolve(),
  };

  return {
    repository,
    addUser,
    challenges,
    sendLog,
    signedIn,
    /** What one session chose to work as, or `null` for the usual role. */
    sessionRoleOf(sessionId: string): Role | null {
      return sessionRoles.get(sessionId) ?? null;
    },
    /** Force a challenge into a state the clock would otherwise have to reach. */
    mutateChallenge(id: string, patch: Partial<ChallengeRecord>) {
      const found = challenges.get(id);
      if (found) challenges.set(id, { ...found, ...patch });
    },
    /** Models the office changing someone's status mid-flow. */
    setUserStatus(userId: string, status: UserStatus) {
      const found = users.get(userId);
      if (found) users.set(userId, { ...found, status });
    },
    /** Forces the role/roles inconsistency that must never be signable. */
    setUserRoles(userId: string, role: Role, roles: Role[]) {
      const found = users.get(userId);
      if (found) users.set(userId, { ...found, role, roles });
    },
    /** Models an account deleted between a code being sent and verified. */
    removeUser(userId: string) {
      users.delete(userId);
    },
  };
}

export function createFakeAuth() {
  const emailsSent: Array<{ email: string; type: string }> = [];
  const smsSent: string[] = [];
  let session: {
    user: { id: string };
    session: { id: string; createdAt: Date; expiresAt: Date };
  } | null = null;

  function cookieHeaders(): Headers {
    const headers = new Headers();
    headers.append('set-cookie', 'plastago.session=abc; Path=/; HttpOnly; SameSite=Lax');
    return headers;
  }

  const api = {
    sendVerificationOTP: ({ body }: { body: { email: string; type: string } }) => {
      emailsSent.push({ email: body.email, type: body.type });
      return Promise.resolve({ success: true });
    },

    sendPhoneNumberOTP: ({ body }: { body: { phoneNumber: string } }) => {
      smsSent.push(body.phoneNumber);
      return Promise.resolve({ success: true });
    },

    signInEmailOTP: ({ body }: { body: { email: string; otp: string } }) => {
      // Better Auth throws on a bad code; the service must treat that as a
      // wrong guess rather than letting it escape as a 500.
      if (body.otp !== VALID_CODE) return Promise.reject(new Error('invalid otp'));
      return Promise.resolve({ headers: cookieHeaders() });
    },

    verifyPhoneNumber: ({ body }: { body: { phoneNumber: string; code: string } }) => {
      if (body.code !== VALID_CODE) return Promise.reject(new Error('invalid code'));
      return Promise.resolve({ headers: cookieHeaders() });
    },

    getSession: () => Promise.resolve(session),

    signOut: () => Promise.resolve({ headers: cookieHeaders() }),
  };

  return {
    api,
    emailsSent,
    smsSent,
    setSession(next: typeof session) {
      session = next;
    },
  };
}
