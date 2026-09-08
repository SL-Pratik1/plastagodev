import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditEntryModel } from '../src/domains/audit/audit.model.js';
import { auditRepository } from '../src/domains/audit/audit.repository.js';

/**
 * The append-only guarantee (M1.6), against a REAL MongoDB.
 *
 * ── Why this cannot be a unit test ────────────────────────────────────────
 * The guarantee is Mongoose middleware, and middleware is precisely the kind of
 * thing that passes against a mocked repository and does nothing in production:
 * a mock never runs the hooks. The only way to know `updateOne` actually throws
 * is to call it against a database.
 *
 * "An audit log you can edit is not an audit log" is the requirement, and this
 * file is the only place it is genuinely checked.
 *
 * Skips itself when Mongo is not reachable, so the suite still runs on a machine
 * with no database rather than failing for the wrong reason.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_audit_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(`${MONGO_URL}/${TEST_DB}`, { serverSelectionTimeoutMS: 2000 });
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

/*
 * ⚠️ Cleaned through the NATIVE DRIVER, not through the model.
 *
 * `AuditEntryModel.deleteMany({})` throws — which is the whole point of this
 * file, and it means the test suite itself cannot use the model to tidy up.
 * `.collection` is the raw driver handle and skips Mongoose middleware
 * entirely.
 *
 * That is also the honest boundary of the guarantee, and it is asserted as a
 * test below rather than left as a comment: the middleware stops the
 * application, and only the database grant described in `audit.model.ts` stops
 * everything else.
 */
beforeEach(async () => {
  if (reachable) await AuditEntryModel.collection.deleteMany({});
});

/** One entry to attack. */
async function seedEntry(): Promise<string> {
  const entry = await auditRepository.record({
    actorId: '650000000000000000000009',
    actorName: 'Renee Alvarez',
    actorRole: 'operations',
    action: 'updated',
    entity: 'job',
    entityId: '650000000000000000000003',
    entityLabel: 'Job #61402',
    summary: 'Ready date changed — Clarendon Homes',
    changes: [{ field: 'readyDate', from: '2026-08-12', to: '2026-08-19' }],
    href: '/admin/jobs/650000000000000000000003',
  });

  return entry.id;
}

describe.runIf(await isReachable())('the audit log refuses to be rewritten', () => {
  it('appends and reads back exactly what was written', async () => {
    const id = await seedEntry();
    const entry = await auditRepository.findById(id);

    expect(entry?.actorName).toBe('Renee Alvarez');
    expect(entry?.changes).toEqual([
      { field: 'readyDate', from: '2026-08-12', to: '2026-08-19' },
    ]);
  });

  it('refuses updateOne', async () => {
    await seedEntry();

    await expect(
      AuditEntryModel.updateOne({}, { $set: { actorName: 'Somebody Else' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses updateMany', async () => {
    await seedEntry();

    await expect(
      AuditEntryModel.updateMany({}, { $set: { summary: 'nothing to see here' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses findOneAndUpdate', async () => {
    await seedEntry();

    await expect(
      AuditEntryModel.findOneAndUpdate({}, { $set: { actorName: 'Somebody Else' } }),
    ).rejects.toThrow(/append-only/i);
  });

  it('refuses replaceOne', async () => {
    await seedEntry();

    await expect(AuditEntryModel.replaceOne({}, { summary: 'replaced' })).rejects.toThrow(
      /append-only/i,
    );
  });

  it('refuses deleteOne', async () => {
    await seedEntry();

    await expect(AuditEntryModel.deleteOne({})).rejects.toThrow(/append-only/i);
  });

  it('refuses deleteMany — the one that would erase the lot', async () => {
    await seedEntry();

    await expect(AuditEntryModel.deleteMany({})).rejects.toThrow(/append-only/i);
  });

  it('refuses findOneAndDelete', async () => {
    await seedEntry();

    await expect(AuditEntryModel.findOneAndDelete({})).rejects.toThrow(/append-only/i);
  });

  it('refuses save() on an entry that already exists', async () => {
    await seedEntry();

    const document = await AuditEntryModel.findOne({});
    expect(document).not.toBeNull();

    document!.summary = 'quietly corrected';

    await expect(document!.save()).rejects.toThrow(/append-only/i);
  });

  it('leaves the entry untouched after every attempt', async () => {
    const id = await seedEntry();

    // Every mutation the model knows how to refuse, fired at one row.
    await Promise.allSettled([
      AuditEntryModel.updateOne({}, { $set: { actorName: 'X' } }),
      AuditEntryModel.updateMany({}, { $set: { actorName: 'X' } }),
      AuditEntryModel.findOneAndUpdate({}, { $set: { actorName: 'X' } }),
      AuditEntryModel.replaceOne({}, { summary: 'X' }),
      AuditEntryModel.deleteOne({}),
      AuditEntryModel.deleteMany({}),
      AuditEntryModel.findOneAndDelete({}),
    ]);

    const entry = await auditRepository.findById(id);

    // The point of the whole file: it is still there, and still says what it said.
    expect(entry).not.toBeNull();
    expect(entry?.actorName).toBe('Renee Alvarez');
    expect(entry?.summary).toBe('Ready date changed — Clarendon Homes');
    expect(await AuditEntryModel.countDocuments({})).toBe(1);
  });

  it('still allows reads, which is the whole point of keeping it', async () => {
    await seedEntry();
    await seedEntry();

    const page = await auditRepository.list({ page: 1, pageSize: 10 });

    expect(page.meta.total).toBe(2);
    expect(page.data).toHaveLength(2);
  });

  /* ── The parts of the schema that carry the guarantee ─────────────────── */

  it('has no TTL index — §6A.2 commits to seven-year retention', async () => {
    await seedEntry();

    const indexes = await AuditEntryModel.collection.indexes();

    // A TTL index is a delete the collection performs on itself, which is the
    // exact thing "immutable" rules out.
    expect(indexes.some((index) => 'expireAfterSeconds' in index)).toBe(false);
  });

  it('indexes the two questions M1.6 is written around', async () => {
    await seedEntry();

    const names = (await AuditEntryModel.collection.indexes()).map((index) => index.name);

    // "What happened to job 61402?" and "what has Priya done?"
    expect(names).toContain('entity_history');
    expect(names).toContain('actor_history');
  });

  it('stores no updatedAt, because a row that cannot change has no such date', async () => {
    await seedEntry();

    const raw = await AuditEntryModel.collection.findOne({});

    expect(raw).not.toBeNull();
    expect(raw).not.toHaveProperty('updatedAt');
    expect(raw).not.toHaveProperty('createdAt');
  });

  /**
   * ⚠️ Pins the LIMIT of the middleware, so nobody mistakes it for the whole
   * guarantee.
   *
   * The raw driver bypasses Mongoose entirely, and no amount of schema code can
   * change that. This test exists so the limitation is a stated fact with a
   * failing test behind it if it ever changes — not an assumption. In production
   * the application's database user is granted `insert` and `find` on this
   * collection and nothing else, which is the barrier that actually holds.
   */
  it('is NOT protected from the raw driver — only the database grant is', async () => {
    await seedEntry();

    // Deliberately succeeds. If this ever starts throwing, the model has grown
    // a guarantee it does not have, and the comment above needs revisiting.
    await AuditEntryModel.collection.deleteMany({});

    expect(await AuditEntryModel.countDocuments({})).toBe(0);
  });

  it('marks application-written entries as attributed', async () => {
    await seedEntry();

    const coverage = await auditRepository.countBySource();

    expect(coverage.application).toBe(1);
    expect(coverage.changeStream).toBe(0);
  });
});

/** Probed before `describe` so the suite can skip cleanly rather than fail. */
async function isReachable(): Promise<boolean> {
  try {
    const probe = await mongoose
      .createConnection(`${MONGO_URL}/${TEST_DB}`, { serverSelectionTimeoutMS: 2000 })
      .asPromise();
    await probe.close();
    return true;
  } catch {
    return false;
  }
}
