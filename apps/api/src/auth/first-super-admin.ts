import { BRAND_IDS } from '@plastago/shared';
import { UserModel } from '../domains/auth/auth.model.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'first-super-admin' });

/**
 * The first super-admin — created at boot on a database that has none.
 *
 * ── Why it exists ───────────────────────────────────────────────────────────
 * Nothing else can make one in production. `seed:auth` refuses to run there,
 * and every way of adding a user in the console needs somebody already signed
 * in. A fresh production database would otherwise be a locked door with the
 * key inside.
 *
 * ── Why it is safe to leave in ──────────────────────────────────────────────
 * It acts only while the database holds NO super-admin at all. The moment one
 * exists — this one or any other — it does nothing, on every later boot. It
 * sends nothing either: no invitation, no welcome. The person signs in with an
 * ordinary email code.
 */
export const FIRST_SUPER_ADMIN = {
  name: 'Test SuperAdmin',
  email: 'pratik.savannahlabs@gmail.com',
} as const;

export type FirstSuperAdminOutcome = 'exists' | 'created' | 'promoted';

export async function ensureFirstSuperAdmin(): Promise<FirstSuperAdminOutcome> {
  if (await UserModel.exists({ roles: 'super-admin' })) return 'exists';

  const email = FIRST_SUPER_ADMIN.email.toLowerCase();
  const existing = await UserModel.exists({ email });

  /*
   * Upsert on the email, so a second instance booting at the same moment
   * cannot make two.
   *
   * If that address already belongs to someone, they are PROMOTED rather than
   * duplicated. `accountId` is cleared because a staff role must not carry one
   * — the users service enforces the same rule.
   */
  await UserModel.updateOne(
    { email },
    {
      $set: {
        role: 'super-admin',
        roles: ['super-admin'],
        status: 'active',
        accountId: null,
      },
      $setOnInsert: {
        name: FIRST_SUPER_ADMIN.name,
        phoneNumber: null,
        jobTitle: 'Administrator',
        brandIds: [...BRAND_IDS],
        // Better Auth's fields — the first email code verifies the address.
        emailVerified: false,
        phoneNumberVerified: false,
        image: null,
        lastSignedInAt: null,
      },
    },
    { upsert: true },
  ).exec();

  const outcome = existing ? 'promoted' : 'created';
  log.warn({ email, outcome }, 'no super-admin existed — the first one is in place');
  return outcome;
}
