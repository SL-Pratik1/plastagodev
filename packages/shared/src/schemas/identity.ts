import * as z from 'zod';
import { ROLES, type Role } from '../constants.js';
import { IsoDateTimeSchema, ObjectIdSchema } from './primitives.js';

/**
 * Identity, session and OTP contract (§9, M1.5).
 *
 * Declared here rather than in the web app because SSO spans every surface —
 * admin console, customer portal, driver PWA and the Flutter app all resolve the
 * same session shape (§9). One definition, four consumers.
 *
 * ⚠️ No endpoints are declared for these schemas yet. They are the *shapes* the
 * UI is built against; the paths join `openapi/document.ts` when the auth domain
 * is implemented, so the contract stays generated rather than hand-written.
 */

export const RoleSchema = z.enum(ROLES).meta({ id: 'Role' });

/**
 * Which application a role signs in to. `driver` is a SEPARATE Vite app with its
 * own service worker (§6A.5), so it is a surface, not a route group.
 */
export const SURFACES = ['admin', 'portal', 'driver'] as const;
export const SurfaceSchema = z.enum(SURFACES).meta({ id: 'Surface' });
export type Surface = z.infer<typeof SurfaceSchema>;

/** A1 email OTP · A2 SMS OTP. There are no passwords in this product (§9). */
export const AUTH_CHANNELS = ['email', 'sms'] as const;
export const AuthChannelSchema = z.enum(AUTH_CHANNELS).meta({ id: 'AuthChannel' });
export type AuthChannel = z.infer<typeof AuthChannelSchema>;

/** Human labels for the seven roles, so no surface invents its own wording. */
export const ROLE_LABELS: Record<Role, string> = {
  'super-admin': 'Super admin',
  operations: 'Operations',
  'office-staff': 'Office staff',
  allocator: 'Allocator',
  driver: 'Driver',
  'customer-administrator': 'Customer administrator',
  'customer-site-supervisor': 'Site supervisor',
};

/** Where each role belongs after sign-in (§6A.5 role-based routing). */
export const ROLE_SURFACE: Record<Role, Surface> = {
  'super-admin': 'admin',
  operations: 'admin',
  'office-staff': 'admin',
  allocator: 'admin',
  driver: 'driver',
  'customer-administrator': 'portal',
  'customer-site-supervisor': 'portal',
};

/**
 * The channel §9 names as *primary* for each role — email for office, admin and
 * customer administrators; SMS for site supervisors and drivers.
 *
 * "Primary", not exclusive: the document does not forbid the other channel, and
 * the sign-in screen cannot know the role before the identifier is resolved
 * anyway. So this table is for presentation and defaults, never a gate.
 */
export const ROLE_PRIMARY_CHANNEL: Record<Role, AuthChannel> = {
  'super-admin': 'email',
  operations: 'email',
  'office-staff': 'email',
  allocator: 'email',
  driver: 'sms',
  'customer-administrator': 'email',
  'customer-site-supervisor': 'sms',
};

/** Length of the one-time code. Matt's SMS wording says "6-digit code". */
export const OTP_CODE_LENGTH = 6;

/** Australian mobile, any of `0412345678`, `+61412345678`, `0412 345 678`. */
const AU_MOBILE = /^(?:\+?61|0)4\d{8}$/;

/** Strip the spaces, brackets and hyphens people type on a phone keypad. */
export function normaliseMobile(value: string): string {
  const digits = value.replace(/[\s()-]/g, '');
  if (digits.startsWith('+61')) return `0${digits.slice(3)}`;
  if (digits.startsWith('61') && digits.length === 11) return `0${digits.slice(2)}`;
  return digits;
}

export function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

export function isAustralianMobile(value: string): boolean {
  return AU_MOBILE.test(normaliseMobile(value));
}

/** Which channel an identifier implies, before any user record is resolved. */
export function channelForIdentifier(value: string): AuthChannel {
  return looksLikeEmail(value) ? 'email' : 'sms';
}

/**
 * One field accepts both, because the screen cannot know the role yet. The
 * message names both options — a site supervisor in the rain should not have to
 * guess which one this box wants.
 */
export const AuthIdentifierSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address or mobile number')
  .refine(
    (value) =>
      looksLikeEmail(value) ? z.email().safeParse(value).success : isAustralianMobile(value),
    'Enter a valid email address or Australian mobile number, e.g. 0412 345 678',
  )
  .meta({ id: 'AuthIdentifier' });

export const OtpRequestSchema = z
  .object({ identifier: AuthIdentifierSchema })
  .meta({ id: 'OtpRequest' });

/**
 * What the server returns after sending a code.
 *
 * `sentTo` is deliberately MASKED. It has to be shown — a supervisor with two
 * numbers needs to know which phone to look at — but echoing the full address
 * back to an unauthenticated caller turns the form into an enumeration oracle.
 */
export const OtpChallengeSchema = z
  .object({
    challengeId: z.string().min(1),
    channel: AuthChannelSchema,
    sentTo: z
      .string()
      .min(1)
      .describe('Masked destination, e.g. "•••• 678" or "m•••@iplasta.com.au"'),
    expiresAt: IsoDateTimeSchema,
    resendAvailableAt: IsoDateTimeSchema,
    attemptsRemaining: z.number().int().nonnegative(),
  })
  .meta({ id: 'OtpChallenge' });

export const OtpVerifySchema = z
  .object({
    challengeId: z.string().min(1),
    code: z
      .string()
      .trim()
      .regex(
        new RegExp(`^\\d{${String(OTP_CODE_LENGTH)}}$`),
        `Enter the ${String(OTP_CODE_LENGTH)}-digit code`,
      ),
  })
  .meta({ id: 'OtpVerify' });

/**
 * The signed-in user.
 *
 * `brandIds` is present because brand is a first-class dimension, not a setting
 * (M1.1) — EasyLift is operationally live today. `accountId` is set only for the
 * two customer roles: it scopes the portal to one account (M1.5).
 */
export const AuthenticatedUserSchema = z
  .object({
    id: ObjectIdSchema,
    name: z.string().min(1),
    email: z.email().nullable(),
    mobile: z.string().nullable(),
    role: RoleSchema,
    jobTitle: z.string().nullable(),
    brandIds: z.array(z.string().min(1)),
    accountId: ObjectIdSchema.nullable(),
    lastSignedInAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'AuthenticatedUser' });

/**
 * Session metadata the UI is allowed to see.
 *
 * No tokens here on purpose: web auth is a short-lived JWT in an httpOnly
 * cookie (§6A.1), so the browser must never be able to read it. `expiresAt`
 * exists so the UI can warn before it lapses rather than failing a save.
 */
export const SessionSchema = z
  .object({
    user: AuthenticatedUserSchema,
    issuedAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema,
  })
  .meta({ id: 'Session' });

export type OtpRequest = z.infer<typeof OtpRequestSchema>;
export type OtpChallenge = z.infer<typeof OtpChallengeSchema>;
export type OtpVerify = z.infer<typeof OtpVerifySchema>;
export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type Session = z.infer<typeof SessionSchema>;
