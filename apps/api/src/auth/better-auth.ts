import { OTP_CODE_LENGTH, isAustralianMobile } from '@plastago/shared';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { emailOTP, phoneNumber } from 'better-auth/plugins';
import { env, isProduction } from '../config/env.js';
import { getMongoClient, getMongoDb, isMongoConnected, supportsTransactions } from '../db/mongo.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import { getMailer, getSmsSender } from '../integrations/messaging.js';
import { buildOtpEmail, buildOtpSms } from '../integrations/otp-messages.js';
import { rememberOtpCode } from './otp-peek.js';
import { USERS_COLLECTION } from '../domains/auth/auth.model.js';

const log = logger.child({ module: 'better-auth' });

export type Auth = ReturnType<typeof buildAuth>;

/**
 * Better Auth — the OTP, session and token machinery (§9, M1.5).
 *
 * ── What this owns, and what it does not ────────────────────────────────────
 * It owns credentials: generating a one-time code, hashing and storing it,
 * counting attempts, expiring it, and issuing and revoking sessions. Getting
 * any of that subtly wrong is a security bug, and it is exactly the class of
 * code that should not be hand-written.
 *
 * It does NOT own the domain. Roles, brands, account scoping and the shape of
 * `Session` on the wire belong to this codebase, and are assembled in
 * `auth.service.ts` from the user document.
 *
 * ── ONE users collection (a hard requirement) ───────────────────────────────
 * `user.modelName` points Better Auth at our own `users` collection and our
 * domain fields are declared as `additionalFields`, so a person is ONE document
 * that both sides read. There is no second identity table to keep in step.
 *
 * The division of ownership inside that document:
 *   • Better Auth writes  — email, emailVerified, phoneNumber,
 *                           phoneNumberVerified, name, image, createdAt,
 *                           updatedAt
 *   • our repository writes — role, roles, status, accountId, brandIds,
 *                           jobTitle, lastSignedInAt
 * Neither writes the other's fields. `auth.repository.ts` uses targeted `$set`
 * updates for exactly this reason: a whole-document `save()` from the Mongoose
 * side would silently drop whatever Better Auth had just written.
 *
 * Better Auth does create three small collections of its own — `session`,
 * `account` and `verification`. They hold sessions and pending codes, not
 * people, and nothing in the product treats them as a user directory.
 *
 * ── Why its HTTP handler is NOT mounted ─────────────────────────────────────
 * Better Auth can serve its own routes at `/api/auth/*`. We deliberately do not
 * mount them, and reach it only through `auth.api.*` from our own controllers.
 * Two reasons: every route the platform exposes should appear in the generated
 * OpenAPI document that the Flutter app codegens from (§6A.9), and the sign-in
 * contract the screens are already built against is challenge-based — which is
 * a shape Better Auth does not serve. One documented surface, no shadow API.
 */
function buildAuth(transactionsAvailable: boolean) {
  return betterAuth({
    appName: 'PlastaGo',
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.AUTH_BASE_URL,
    trustedOrigins: env.CORS_ORIGINS,

    database: mongodbAdapter(getMongoDb(), {
      // Sharing Mongoose's client, so there is one pool and one shutdown path.
      client: getMongoClient(),
      // ⚠️ A standalone mongod cannot open a session, and the adapter would
      // wrap writes in one if we let it (§6A.3 #3). Detected, not assumed —
      // Atlas gets transactions, a developer's laptop does not.
      transaction: transactionsAvailable,
    }),

    // There are no passwords anywhere in this product (§9). Leaving this on
    // would expose a second way in that nobody intends to support.
    emailAndPassword: { enabled: false },

    user: {
      modelName: USERS_COLLECTION,
      additionalFields: {
        /**
         * The role this person is acting as right now. Always a member of
         * `roles` — enforced by `$jsonSchema` and by the users domain.
         *
         * A plain string, not a reference: the capability matrix in
         * `features/auth/permissions.ts` is keyed by the role NAME, so an id
         * here would mean a lookup on every request that returns the same word
         * we started with. Fixed lists are values; entities get references.
         */
        role: { type: 'string', required: false, input: false },
        /** Every role held. Matt, 27:01 — an allocator who covers a sick driver. */
        roles: { type: 'string[]', required: false, input: false },
        status: { type: 'string', required: false, input: false, defaultValue: 'active' },
        jobTitle: { type: 'string', required: false, input: false },
        /**
         * REFERENCE → `accounts._id`. Set only for the two customer roles; it
         * is what scopes the portal to one account (M1.5).
         */
        accountId: { type: 'string', required: false, input: false },
        /** REFERENCES → `brands._id`. See `brand.model.ts` for why these are slugs. */
        brandIds: { type: 'string[]', required: false, input: false },
        lastSignedInAt: { type: 'date', required: false, input: false },
      },
    },

    session: {
      expiresIn: env.AUTH_SESSION_TTL_HOURS * 60 * 60,
      // Slide the expiry at most once an hour, so a working day of activity
      // does not mean a database write on every request.
      updateAge: 60 * 60,
    },

    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        // Dev is plain http on localhost; anything deployed is https.
        secure: isProduction,
        path: '/',
      },
      // ⚠️ Do NOT set `database.generateId`. Left alone, the Mongo adapter
      // stores `_id` as a native ObjectId and hands it back as a 24-character
      // hex string — which is precisely what `ObjectIdSchema` on the wire and
      // Mongoose's `ObjectId` refs both need. Overriding it would store ids as
      // plain strings and break every `$lookup` and `populate` in the platform.
    },

    plugins: [
      /**
       * A1 — email OTP. Primary for office, admin and customer administrators.
       *
       * `disableSignUp` is the load-bearing option: without it, an unrecognised
       * email address would CREATE a user and let them in. This is a
       * single-tenant internal system where every account is invited by the
       * office (M5 Part 2), so an unknown address must never become one.
       */
      emailOTP({
        otpLength: OTP_CODE_LENGTH,
        expiresIn: env.OTP_TTL_SECONDS,
        allowedAttempts: env.OTP_MAX_ATTEMPTS,
        disableSignUp: true,
        /**
         * ⚠️ NOT THE DEFAULT. Better Auth stores OTPs as `"643104:0"` — the
         * code in PLAIN TEXT — unless told otherwise, which means anyone with
         * read access to the database can sign in as anybody for the five
         * minutes a code is live. Verified by reading the `verification`
         * collection during development.
         *
         * `hashed` stores a digest and compares in constant time, so a database
         * read no longer yields a working credential. Nothing about the code
         * the user receives changes.
         */
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email, otp, type }) => {
          // Only sign-in codes exist in this product: there is no password to
          // reset and no separate address-verification step.
          if (type !== 'sign-in') {
            log.warn({ type }, 'ignoring a non sign-in OTP request');
            return;
          }
          rememberOtpCode(email, otp);
          await getMailer().send(buildOtpEmail(email, otp));
        },
      }),

      /**
       * A2 — SMS OTP. Primary for drivers and site supervisors (§9).
       *
       * No `signUpOnVerification`, for the same reason `disableSignUp` is set
       * above: verifying a code must never be able to mint an account.
       *
       * ⚠️ KNOWN GAP — SMS codes are stored in plain text, and cannot currently
       * be hashed. `emailOTP` takes a `storeOTP` option; `phoneNumber` (1.7.3)
       * has no equivalent, so the code sits readable in `verification` for the
       * five minutes it is valid. Raised deliberately rather than left to be
       * discovered.
       *
       * Compensating controls already in place: a five-minute lifetime, five
       * attempts, single use, and a per-identifier send ceiling. The residual
       * risk is an attacker who ALREADY has database read access — at which
       * point they can read every job, invoice and photo reference anyway, so
       * this is not the weakest link. It is still worth closing.
       *
       * To close it: implement the plugin's `verifyOTP` hook against a digest
       * we store ourselves, or upstream a `storeOTP` option to the plugin. Not
       * done now because either is a change to how codes are generated, and
       * that wants its own review rather than riding along with the domain.
       */
      phoneNumber({
        otpLength: OTP_CODE_LENGTH,
        expiresIn: env.OTP_TTL_SECONDS,
        allowedAttempts: env.OTP_MAX_ATTEMPTS,
        // Reuses the shared validator, so the API and the sign-in form agree on
        // what an Australian mobile is.
        phoneNumberValidator: (value: string) => isAustralianMobile(value),
        sendOTP: async ({ phoneNumber: to, code }) => {
          rememberOtpCode(to, code);
          await getSmsSender().send(buildOtpSms(to, code));
        },
      }),
    ],
  });
}

let instance: Auth | undefined;

/**
 * Built once at boot, AFTER `connectMongo()`, because the adapter needs a live
 * `Db` handle. Kept out of `createServer()` so tests can still assemble an app
 * with no I/O at all.
 */
export async function initAuth(): Promise<void> {
  if (instance) return;

  if (!isMongoConnected()) {
    // Matches the degraded-mode contract in `mongo.ts`: in development the API
    // keeps serving and `/readyz` reports the truth. Sign-in will answer 503
    // rather than the process refusing to boot.
    log.warn('MongoDB is not connected — authentication is unavailable until it is');
    return;
  }

  instance = buildAuth(await supportsTransactions());
  log.info(
    { mail: env.MAIL_PROVIDER, sms: env.SMS_PROVIDER, users: USERS_COLLECTION },
    'authentication ready',
  );
}

export function getAuth(): Auth {
  if (!instance) {
    throw AppError.dependencyUnavailable('Authentication is not available right now');
  }
  return instance;
}

/** True once Better Auth has a database. Read by `/readyz` and by tests. */
export function isAuthReady(): boolean {
  return instance !== undefined;
}

/** Test seam — lets a suite build the instance against an in-process Mongo. */
export async function resetAuthForTests(): Promise<void> {
  instance = undefined;
  await initAuth();
}
