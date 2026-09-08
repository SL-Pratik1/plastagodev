import type { Role } from '@plastago/shared';

/**
 * The accounts `npm run seed:auth` creates in a development database.
 *
 * ── What this is, and what it is emphatically not ─────────────────────────
 * A DEVELOPMENT CONVENIENCE. It mirrors `apps/api/src/scripts/seed-auth.ts` so
 * the sign-in screen can offer tap-to-fill instead of making somebody retype
 * `allocations@plastago.com.au` forty times a day. Nothing here authenticates
 * anything: the code is a real one-time code, sent by the real API, and these
 * rows are just identifiers.
 *
 * It replaced `services/mock/fixtures/identities.ts`, which carried a
 * hardcoded OTP the mock accepted. That constant is deliberately NOT carried
 * over — with a real backend it would be advertising a code that does not work,
 * which is worse than offering nothing.
 *
 * ⚠️ Every use site must be behind `import.meta.env.DEV`. Vite replaces that
 * with a literal `false` in a production build, so this list is eliminated
 * rather than shipped to a customer.
 *
 * If the seed script changes, change this too. They are two lists of the same
 * eight people and there is no build-time link between them.
 */
export interface SeededIdentity {
  readonly name: string;
  readonly email: string | null;
  readonly mobile: string | null;
  readonly role: Role;
  readonly jobTitle: string;
}

export const SEEDED_IDENTITIES: readonly SeededIdentity[] = [
  {
    name: 'Matthew Browne',
    email: 'matt@plastago.com.au',
    mobile: '0412345678',
    role: 'super-admin',
    jobTitle: 'Operations Director',
  },
  {
    name: 'Renee Alvarez',
    email: 'renee@plastago.com.au',
    mobile: null,
    role: 'operations',
    jobTitle: 'Operations Manager',
  },
  {
    name: 'Priya Raman',
    email: 'office@plastago.com.au',
    mobile: null,
    role: 'office-staff',
    jobTitle: 'Office Administrator',
  },
  {
    // Matt, 27:01 — an allocator who covers a driver's shift holds both roles.
    name: 'Dean Kelly',
    email: 'allocations@plastago.com.au',
    mobile: null,
    role: 'allocator',
    jobTitle: 'Driver Manager',
  },
  {
    // SMS-first (§9 A2): a driver on a building site has no email to check.
    name: 'Troy Holm',
    email: null,
    mobile: '0455112233',
    role: 'driver',
    jobTitle: 'Driver',
  },
  {
    name: 'Angela Fitzgerald',
    email: 'accounts@iplasta.com.au',
    mobile: null,
    role: 'customer-administrator',
    jobTitle: 'Accounts Manager, iPlasta Pty Ltd',
  },
  {
    name: 'Dave Nguyen',
    email: null,
    mobile: '0466778899',
    role: 'customer-site-supervisor',
    jobTitle: 'Site Supervisor, iPlasta',
  },
];
