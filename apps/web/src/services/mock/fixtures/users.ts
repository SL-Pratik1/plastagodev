import type { Role, User } from '@plastago/shared';
import { ACCOUNTS, createRng, intBetween, objectId, pick } from './reference';
import { DEMO_IDENTITIES } from './identities';

/**
 * User fixtures (M1.5).
 *
 * The seven demo sign-ins come first so the person signing in can find
 * themselves in the list, then a tail of customer users — because that is the
 * real population shape: a handful of staff, and a site-contact population in
 * the low hundreds across 31 active accounts.
 */
const FIRST = [
  'Dave',
  'Sione',
  'Brett',
  'Ali',
  'Kelly',
  'Marcus',
  'Julia',
  'Rosa',
  'Tom',
  'Nadia',
  'Craig',
  'Petra',
  'Vince',
  'Hannah',
  'Owen',
  'Bianca',
  'Lachlan',
  'Mei',
  'Jarrah',
  'Elena',
];
const LAST = [
  'Nguyen',
  'Tupou',
  'Sanders',
  'Rahimi',
  'O’Brien',
  'Webb',
  'Kefalas',
  'Fornari',
  'Ashworth',
  'Haddad',
  'Peterson',
  'Nowak',
  'Marino',
  'Lu',
  'Barrett',
  'Silva',
  'Doyle',
  'Chen',
  'Watts',
  'Popovic',
];

function isoAgo(days: number, hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function build(): User[] {
  const rng = createRng(31415926);
  const users: User[] = [];

  // The demo identities, promoted to full user records.
  for (const [index, identity] of DEMO_IDENTITIES.entries()) {
    const account = ACCOUNTS.find((candidate) => candidate.id === identity.accountId);
    const isDriver = identity.role === 'driver';

    users.push({
      id: identity.id,
      name: identity.name,
      email: identity.email,
      mobile: identity.mobile,
      role: identity.role,
      status: 'active',
      brandIds: identity.brandIds as User['brandIds'],
      accountId: identity.accountId,
      accountName: account?.name ?? null,
      siteCount: identity.role === 'customer-site-supervisor' ? 1 : 0,
      lastSignedInAt: identity.lastSignedInAt,
      createdAt: isoAgo(400 - index * 20, 9),
      jobTitle: identity.jobTitle,
      invitedBy: index === 0 ? null : 'Matthew Browne',
      notes: '',
      // §6A.8 — a driver's device sync health has to be visible somewhere.
      devices: isDriver
        ? [
            {
              id: objectId('dv', index + 1),
              label: identity.name === 'Troy Holm' ? 'iPhone 14' : 'Samsung S23 Ultra',
              platform: identity.name === 'Troy Holm' ? 'ios' : 'android',
              lastSeenAt: isoAgo(0, 15),
              pendingSyncActions: 0,
              lastSyncAt: isoAgo(0, 15),
            },
          ]
        : [],
      recentSignIns: Array.from({ length: intBetween(rng, 2, 5) }, (_, signInIndex) => ({
        id: objectId('si', index * 10 + signInIndex),
        at: isoAgo(signInIndex * 2, intBetween(rng, 6, 18)),
        channel: identity.email ? ('email' as const) : ('sms' as const),
        outcome: signInIndex === 2 ? ('failed-code' as const) : ('success' as const),
        device: identity.email ? 'Chrome on Windows' : 'Safari on iOS',
      })),
    });
  }

  // Customer users across the active accounts.
  const customerAccounts = ACCOUNTS.filter(
    (account) => account.status === 'active' && account.code !== 'PRE001',
  );

  for (let index = 0; index < 34; index += 1) {
    const account = customerAccounts[index % customerAccounts.length]!;
    const role: Role = index % 6 === 0 ? 'customer-administrator' : 'customer-site-supervisor';
    const name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
    const isAdmin = role === 'customer-administrator';
    const status = index % 11 === 0 ? 'invited' : index % 17 === 0 ? 'suspended' : 'active';

    users.push({
      id: objectId('us', 100 + index),
      name,
      email: isAdmin
        ? `${name.split(' ')[0]?.toLowerCase() ?? 'user'}@${account.code.toLowerCase()}.com.au`
        : null,
      mobile: isAdmin ? null : `04${String(intBetween(rng, 10000000, 99999999))}`.slice(0, 10),
      role,
      status,
      brandIds: [account.brandId],
      accountId: account.id,
      accountName: account.name,
      siteCount: isAdmin ? 0 : intBetween(rng, 1, 3),
      lastSignedInAt: status === 'invited' ? null : isoAgo(intBetween(rng, 0, 40), 11),
      createdAt: isoAgo(intBetween(rng, 30, 320), 10),
      jobTitle: isAdmin ? 'Accounts' : 'Site Supervisor',
      invitedBy: pick(rng, ['Matthew Browne', 'Priya Raman', 'Renee Alvarez']),
      notes: '',
      devices: [],
      recentSignIns:
        status === 'invited'
          ? []
          : [
              {
                id: objectId('si', 900 + index),
                at: isoAgo(intBetween(rng, 0, 20), 13),
                channel: isAdmin ? ('email' as const) : ('sms' as const),
                outcome: 'success' as const,
                device: isAdmin ? 'Edge on Windows' : 'Chrome on Android',
              },
            ],
    });
  }

  return users;
}

export const USERS: readonly User[] = build();
