import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureFirstSuperAdmin, FIRST_SUPER_ADMIN } from '../src/auth/first-super-admin.js';
import { UserModel } from '../src/domains/auth/auth.model.js';

/**
 * The first super-admin runs on EVERY boot of the live API, so the part that
 * matters most is the part where it does nothing: once any super-admin exists
 * it must never create, promote or touch anyone again.
 *
 * A real Mongo, because the behaviour is an upsert and an existence check —
 * exactly what a fake would agree with whatever it was handed. Skips where
 * there is no Mongo.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_first_admin_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
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
  if (reachable) await UserModel.deleteMany({});
});

const email = FIRST_SUPER_ADMIN.email.toLowerCase();

describe('ensureFirstSuperAdmin', () => {
  it('creates an active super-admin on an empty database', async () => {
    if (!reachable) return;

    expect(await ensureFirstSuperAdmin()).toBe('created');

    const user = await UserModel.findOne({ email }).lean<Record<string, unknown>>();
    expect(user).toMatchObject({
      name: FIRST_SUPER_ADMIN.name,
      role: 'super-admin',
      roles: ['super-admin'],
      status: 'active',
      accountId: null,
    });
  });

  it('does nothing on the next boot, so it never makes a second one', async () => {
    if (!reachable) return;

    await ensureFirstSuperAdmin();
    expect(await ensureFirstSuperAdmin()).toBe('exists');

    expect(await UserModel.countDocuments({})).toBe(1);
  });

  it('leaves a database that already has a super-admin completely alone', async () => {
    if (!reachable) return;
    await UserModel.collection.insertOne({
      name: 'Someone Else',
      email: 'boss@example.com',
      role: 'super-admin',
      roles: ['super-admin'],
      status: 'active',
    });

    expect(await ensureFirstSuperAdmin()).toBe('exists');

    expect(await UserModel.exists({ email })).toBeNull();
  });

  it('promotes the address rather than duplicating it, and drops a customer account link', async () => {
    if (!reachable) return;
    await UserModel.collection.insertOne({
      name: 'Already Here',
      email,
      role: 'customer-administrator',
      roles: ['customer-administrator'],
      status: 'invited',
      accountId: new mongoose.Types.ObjectId(),
    });

    expect(await ensureFirstSuperAdmin()).toBe('promoted');

    const users = await UserModel.find({ email }).lean<Array<Record<string, unknown>>>();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      name: 'Already Here',
      role: 'super-admin',
      roles: ['super-admin'],
      status: 'active',
      accountId: null,
    });
  });
});
