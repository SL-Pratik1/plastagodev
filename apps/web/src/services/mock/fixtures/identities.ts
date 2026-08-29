import type { AuthenticatedUser, Role } from '@plastago/shared';
import { ACCOUNTS } from './reference';

/**
 * Demo identities for the mock sign-in.
 *
 * ⚠️ FIXTURES, NOT DATA. Nothing here is a business fact and none of it is a
 * user record — it exists so the seven roles of M1.5 can each be signed in and
 * demonstrated before the users domain is built. Delete this file when the real
 * directory lands.
 *
 * Names and companies are taken from the world the scope document already
 * describes (§6, M1.2) so the demo reads as PlastaGo rather than as
 * `test@test.com` — which is the difference between a client seeing their
 * business and a client seeing a template.
 */

export interface DemoIdentity extends AuthenticatedUser {
  /** Shown on the sign-in screen's demo panel so the flow is walkable. */
  readonly hint: string;
}

const BRANDS_ALL = ['plastago', 'easylift', 'brickgo'] as const;

/**
 * The account the two customer identities belong to.
 *
 * Taken from the fixtures rather than hard-coded, because a hand-typed ObjectId
 * that does not match any account produces a portal that throws NOT_FOUND on
 * every screen — which is exactly what a literal id here used to do.
 *
 * iPlasta is the right choice for a demo: it is their largest account and it is
 * m²-only, so the portal's "we do not record weight for you" paths are the ones
 * a client sees first.
 */
const DEMO_ACCOUNT = ACCOUNTS[0];

export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  {
    id: '66b3f0c1a2d4e5f6a7b8c901',
    name: 'Matthew Browne',
    email: 'matt@plastago.com.au',
    mobile: '0412345678',
    role: 'super-admin',
    jobTitle: 'Operations Director',
    brandIds: [...BRANDS_ALL],
    accountId: null,
    lastSignedInAt: '2026-08-24T22:15:00.000Z',
    hint: 'Full access — every screen, including system configuration',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c902',
    name: 'Renee Alvarez',
    email: 'renee@plastago.com.au',
    mobile: null,
    role: 'operations',
    jobTitle: 'Operations Manager',
    brandIds: ['plastago', 'easylift'],
    accountId: null,
    lastSignedInAt: '2026-08-25T00:40:00.000Z',
    hint: 'Everything operational and commercial; no system configuration',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c903',
    name: 'Priya Raman',
    email: 'office@plastago.com.au',
    mobile: null,
    role: 'office-staff',
    jobTitle: 'Office Administrator',
    brandIds: ['plastago'],
    accountId: null,
    lastSignedInAt: '2026-08-25T01:05:00.000Z',
    hint: 'Intake, the exception queues and invoicing. No dispatch board',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c904',
    name: 'Dean Kelly',
    email: 'allocations@plastago.com.au',
    mobile: null,
    role: 'allocator',
    jobTitle: 'Driver Manager',
    brandIds: ['plastago'],
    accountId: null,
    lastSignedInAt: '2026-08-25T02:10:00.000Z',
    hint: 'Board, run sheets, drivers and vehicles — and no pricing anywhere',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c905',
    name: 'Troy Holm',
    email: null,
    mobile: '0455112233',
    role: 'driver',
    jobTitle: 'Driver',
    brandIds: ['easylift'],
    accountId: null,
    lastSignedInAt: '2026-08-25T05:55:00.000Z',
    // Drivers are SMS-first (§9 A2). They sign in HERE now — the driver screens
    // are `/driver/*` in this app rather than a separate build (§6A.5), which is
    // what makes the Install button on their run sheet possible at all.
    hint: 'SMS code — the run sheet, and the app you install on your phone',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c906',
    name: 'Angela Fitzgerald',
    email: 'accounts@iplasta.com.au',
    mobile: null,
    role: 'customer-administrator',
    jobTitle: 'Accounts Manager, iPlasta Pty Ltd',
    brandIds: ['plastago'],
    accountId: DEMO_ACCOUNT?.id ?? null,
    lastSignedInAt: '2026-08-22T04:30:00.000Z',
    hint: 'Customer portal — every site, plus invoices, reports and certificates',
  },
  {
    id: '66b3f0c1a2d4e5f6a7b8c907',
    name: 'Dave Nguyen',
    email: null,
    mobile: '0466778899',
    role: 'customer-site-supervisor',
    jobTitle: 'Site Supervisor, iPlasta',
    brandIds: ['plastago'],
    accountId: DEMO_ACCOUNT?.id ?? null,
    lastSignedInAt: '2026-08-25T03:20:00.000Z',
    hint: 'Customer portal — their own sites only, and no pricing anywhere',
  },
];

/**
 * The code every demo identity accepts.
 *
 * A fixed code, shown on screen, is the honest choice for a UI-only build: the
 * alternative is a code printed to a console nobody in a demo meeting is
 * looking at. The mock is the only thing that knows it; nothing in the real flow
 * will.
 */
export const DEMO_OTP_CODE = '123456';

/** An identifier that resolves to nobody, for demonstrating the failure path. */
export const DEMO_UNKNOWN_IDENTIFIER = 'nobody@example.com';

export function findIdentityByEmail(email: string): DemoIdentity | undefined {
  const needle = email.trim().toLowerCase();
  return DEMO_IDENTITIES.find((identity) => identity.email?.toLowerCase() === needle);
}

export function findIdentityByMobile(mobile: string): DemoIdentity | undefined {
  return DEMO_IDENTITIES.find((identity) => identity.mobile === mobile);
}

export function identitiesForRole(role: Role): readonly DemoIdentity[] {
  return DEMO_IDENTITIES.filter((identity) => identity.role === role);
}
