import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccountModel } from '../src/domains/accounts/account.model.js';
import { UserModel } from '../src/domains/auth/auth.model.js';
import { SortdSessionModel, SortdWebhookEventModel } from '../src/domains/sortd/sortd.model.js';
import { sortdRepository } from '../src/domains/sortd/sortd.repository.js';

/**
 * The Sortd repository against a real Mongo, because what matters here is
 * index behaviour — one session per user per surface, a dedupe that holds
 * under a race, rows that expire themselves — which a fake would simply agree
 * with. No network: nothing in this file calls Sortd.
 *
 * ⚠️ Always the local server, never `MONGODB_URI`: that variable comes from
 * the developer's `.env` and can point at a shared database. Skips where there
 * is no local Mongo.
 */

const MONGO_URL = 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_sortd_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    await Promise.all([SortdSessionModel.syncIndexes(), SortdWebhookEventModel.syncIndexes()]);
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (reachable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

beforeEach(async () => {
  if (!reachable) return;
  await Promise.all([
    SortdSessionModel.deleteMany({}),
    SortdWebhookEventModel.deleteMany({}),
    UserModel.deleteMany({}),
    AccountModel.deleteMany({}),
  ]);
});

const USER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';

function session(sessionId: string, surface: 'admin' | 'portal' | 'driver' = 'driver') {
  return {
    userId: USER,
    surface,
    sessionId,
    expiresAt: new Date(Date.now() + 86_400_000),
    sortdRole: 'user' as const,
    appTenantId: null,
  };
}

describe('sortd sessions', () => {
  it('keeps one row per user per surface — a second save overwrites', async () => {
    if (!reachable) return;

    await sortdRepository.saveSession(session('ess_tab_one'));
    await sortdRepository.saveSession(session('ess_tab_two'));

    expect(await SortdSessionModel.countDocuments({})).toBe(1);
    expect((await sortdRepository.findSession(USER, 'driver'))?.sessionId).toBe('ess_tab_two');
  });

  it('refuses a second row for the same user and surface at the database', async () => {
    if (!reachable) return;

    await SortdSessionModel.create({ ...session('ess_a'), userId: new mongoose.Types.ObjectId(USER) });
    await expect(
      SortdSessionModel.create({ ...session('ess_b'), userId: new mongoose.Types.ObjectId(USER) }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('holds a session per surface side by side', async () => {
    if (!reachable) return;

    await sortdRepository.saveSession(session('ess_console', 'admin'));
    await sortdRepository.saveSession(session('ess_run', 'driver'));

    expect((await sortdRepository.findSession(USER, 'admin'))?.sessionId).toBe('ess_console');
    expect((await sortdRepository.findSession(USER, 'driver'))?.sessionId).toBe('ess_run');
    expect(await sortdRepository.findSession(USER, 'portal')).toBeNull();
  });

  it('round-trips what the session was minted as', async () => {
    if (!reachable) return;

    await sortdRepository.saveSession({
      ...session('ess_admin', 'portal'),
      sortdRole: 'admin',
      appTenantId: '64b0000000000000000000a1',
    });

    expect(await sortdRepository.findSession(USER, 'portal')).toMatchObject({
      sortdRole: 'admin',
      appTenantId: '64b0000000000000000000a1',
    });
  });

  it('takes every surface’s session on sign-out, and only this user’s', async () => {
    if (!reachable) return;

    await sortdRepository.saveSession(session('ess_console', 'admin'));
    await sortdRepository.saveSession(session('ess_run', 'driver'));
    await sortdRepository.saveSession({ ...session('ess_someone_else'), userId: OTHER });

    const taken = await sortdRepository.takeAllSessions(USER);

    expect(taken.map((row) => row.sessionId).sort()).toEqual(['ess_console', 'ess_run']);
    expect(await SortdSessionModel.countDocuments({})).toBe(1);
    expect((await sortdRepository.findSession(OTHER, 'driver'))?.sessionId).toBe('ess_someone_else');
  });

  it('expires rows on Sortd’s own expiry', async () => {
    if (!reachable) return;

    const indexes = await SortdSessionModel.collection.indexes();
    expect(indexes.find((index) => index.name === 'sortd_session_ttl')).toMatchObject({
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    });
  });

  it('treats a malformed user id as nobody', async () => {
    if (!reachable) return;

    expect(await sortdRepository.findSession('not-an-id', 'driver')).toBeNull();
    expect(await sortdRepository.takeAllSessions('not-an-id')).toEqual([]);
  });
});

describe('sortd identity', () => {
  it('reads the email and name, and null for an SMS-only user', async () => {
    if (!reachable) return;

    const withEmail = await UserModel.collection.insertOne({
      name: 'Pat Builder',
      email: 'pat@builder.com.au',
      roles: ['customer-administrator'],
      role: 'customer-administrator',
      status: 'active',
    });
    const smsOnly = await UserModel.collection.insertOne({
      name: 'Troy Holm',
      email: null,
      roles: ['driver'],
      role: 'driver',
      status: 'active',
    });

    expect(await sortdRepository.findIdentity(String(withEmail.insertedId))).toEqual({
      email: 'pat@builder.com.au',
      name: 'Pat Builder',
    });
    expect(await sortdRepository.findIdentity(String(smsOnly.insertedId))).toEqual({
      email: null,
      name: 'Troy Holm',
    });
  });

  it('reads the account name as the tenant label', async () => {
    if (!reachable) return;

    const account = await AccountModel.collection.insertOne({ name: 'Clarendon Homes', code: 'CLA' });
    expect(await sortdRepository.findAccountName(String(account.insertedId))).toBe('Clarendon Homes');
    expect(await sortdRepository.findAccountName(OTHER)).toBeNull();
  });
});

describe('sortd webhook dedupe', () => {
  it('claims a delivery once', async () => {
    if (!reachable) return;

    expect(await sortdRepository.claimWebhookEvent('driver:ticket.created:t1')).toBe(true);
    expect(await sortdRepository.claimWebhookEvent('driver:ticket.created:t1')).toBe(false);
    expect(await sortdRepository.claimWebhookEvent('portal:ticket.created:t1')).toBe(true);
  });

  it('lets exactly one of ten concurrent retries through', async () => {
    if (!reachable) return;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => sortdRepository.claimWebhookEvent('driver:ticket.created:race')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('can give a claim back for a retry', async () => {
    if (!reachable) return;

    await sortdRepository.claimWebhookEvent('driver:ticket.created:t2');
    await sortdRepository.releaseWebhookEvent('driver:ticket.created:t2');

    expect(await sortdRepository.claimWebhookEvent('driver:ticket.created:t2')).toBe(true);
  });

  it('throws — not "duplicate" — when the database itself fails', async () => {
    if (!reachable) return;

    // A document that fails validation stands in for any non-duplicate error.
    await expect(sortdRepository.claimWebhookEvent('')).rejects.toThrow();
  });

  it('prunes delivery records after a day', async () => {
    if (!reachable) return;

    const indexes = await SortdWebhookEventModel.collection.indexes();
    expect(indexes.find((index) => index.name === 'sortd_event_ttl')).toMatchObject({
      expireAfterSeconds: 86_400,
    });
  });
});
