import { ROLE_LABELS, type BrandId, type Role, type UserStatus } from '@plastago/shared';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { authRepository } from '../domains/auth/auth.repository.js';
import { UserModel } from '../domains/auth/auth.model.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-auth' });

/**
 * Seeds the brands and one user per role, so the sign-in flow can be exercised
 * end to end before the users domain (M2) exists.
 *
 * ── Why these seven people and not `test@test.com` ─────────────────────────
 * They are the same identities the web app's demo fixtures already use, with
 * the same names, addresses and roles. That means the console looks identical
 * whether it is running on mocks or on the real API, so the cutover is not also
 * a change of demo data — and a difference between the two is a real bug rather
 * than just different test users.
 *
 * ⚠️ DEVELOPMENT ONLY. Refuses to run against production: seeding a known set
 * of accounts into a live single-tenant system is a way in, not a convenience.
 *
 *   npm --workspace @plastago/api run seed:auth
 */

interface SeedUser {
  name: string;
  email: string | null;
  mobile: string | null;
  role: Role;
  roles: Role[];
  jobTitle: string;
  brandIds: BrandId[];
  status?: UserStatus;
}

const SEED_USERS: readonly SeedUser[] = [
  {
    name: 'Matthew Browne',
    email: 'matt@plastago.com.au',
    mobile: '0412345678',
    role: 'super-admin',
    roles: ['super-admin'],
    jobTitle: 'Operations Director',
    brandIds: ['plastago', 'easylift', 'brickgo'],
  },
  {
    name: 'Renee Alvarez',
    email: 'renee@plastago.com.au',
    mobile: null,
    role: 'operations',
    roles: ['operations'],
    jobTitle: 'Operations Manager',
    brandIds: ['plastago', 'easylift'],
  },
  {
    name: 'Priya Raman',
    email: 'office@plastago.com.au',
    mobile: null,
    role: 'office-staff',
    roles: ['office-staff'],
    jobTitle: 'Office Administrator',
    brandIds: ['plastago'],
  },
  {
    name: 'Dean Kelly',
    email: 'allocations@plastago.com.au',
    mobile: null,
    // Matt, 27:01 — an allocator who covers a driver's shift holds both roles.
    role: 'allocator',
    roles: ['allocator', 'driver'],
    jobTitle: 'Driver Manager',
    brandIds: ['plastago'],
  },
  {
    // SMS-first (§9 A2): a driver on a building site has no email to check.
    name: 'Troy Holm',
    email: null,
    mobile: '0455112233',
    role: 'driver',
    roles: ['driver'],
    jobTitle: 'Driver',
    brandIds: ['easylift'],
  },
  {
    name: 'Angela Fitzgerald',
    email: 'accounts@iplasta.com.au',
    mobile: null,
    role: 'customer-administrator',
    roles: ['customer-administrator'],
    jobTitle: 'Accounts Manager, iPlasta Pty Ltd',
    brandIds: ['plastago'],
  },
  {
    name: 'Dave Nguyen',
    email: null,
    mobile: '0466778899',
    role: 'customer-site-supervisor',
    roles: ['customer-site-supervisor'],
    jobTitle: 'Site Supervisor, iPlasta',
    brandIds: ['plastago'],
  },
  {
    // Present so the "that account has been suspended" path is reachable.
    name: 'Former Staffer',
    email: 'suspended@plastago.com.au',
    mobile: null,
    role: 'office-staff',
    roles: ['office-staff'],
    jobTitle: 'No longer with the company',
    brandIds: ['plastago'],
    status: 'suspended',
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-auth refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  await authRepository.createIndexes();
  await authRepository.ensureSchemaValidators();
  await authRepository.seedBrands();
  log.info('brands seeded');

  for (const seed of SEED_USERS) {
    // Upsert on the identifier so re-running does not duplicate anyone, and
    // never overwrite `lastSignedInAt` — that is real activity, not seed data.
    const filter = seed.email ? { email: seed.email } : { phoneNumber: seed.mobile };

    await UserModel.updateOne(
      filter,
      {
        $set: {
          name: seed.name,
          email: seed.email,
          phoneNumber: seed.mobile,
          role: seed.role,
          roles: seed.roles,
          status: seed.status ?? 'active',
          jobTitle: seed.jobTitle,
          brandIds: seed.brandIds,
          accountId: null,
        },
        $setOnInsert: {
          // Better Auth's fields. An OTP sign-in verifies the channel it was
          // sent on, so both start false and are set by the real flow.
          emailVerified: false,
          phoneNumberVerified: false,
          image: null,
          lastSignedInAt: null,
        },
      },
      { upsert: true },
    ).exec();

    log.info(
      { identifier: seed.email ?? seed.mobile, role: ROLE_LABELS[seed.role] },
      'user seeded',
    );
  }

  const total = await UserModel.countDocuments().exec();
  log.info({ users: total }, 'seed complete');

  // Printed rather than logged on purpose: this is the operator's cue after
  // running a script by hand, not telemetry, so it should not be JSON and
  // should not be filtered out by LOG_LEVEL.
  // eslint-disable-next-line no-console
  console.log(`
Seeded ${String(SEED_USERS.length)} users into "${mongoose.connection.name}".

Sign in with any of these — the code prints in the API log while
MAIL_PROVIDER/SMS_PROVIDER are "stub":

  matt@plastago.com.au         super-admin
  renee@plastago.com.au        operations
  office@plastago.com.au       office-staff
  allocations@plastago.com.au  allocator (+ driver)
  0455112233                   driver           ← SMS
  accounts@iplasta.com.au      customer-administrator
  0466778899                   site supervisor  ← SMS
  suspended@plastago.com.au    suspended (demonstrates the refusal path)
`);
}

await main()
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
