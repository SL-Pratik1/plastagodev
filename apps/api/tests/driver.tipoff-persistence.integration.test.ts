import { RunTipOffSchema } from '@plastago/shared';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunTipOffModel } from '../src/domains/dispatch/run.model.js';
import { driverRepository } from '../src/domains/driver/driver.repository.js';

/**
 * That a driver's tip-off actually PERSISTS.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * It did not. `recordTipOff` wrote `totalKg`, `docketReference`, `docketPhotoId`,
 * `date` and `recordedByUserId`; the schema defines `netKg`, `docketNumber` and
 * `docketPhotoKey`. Mongoose runs strict by default, so every one of those
 * unknown paths was silently dropped on the way to the database. The write
 * acknowledged, the route answered 204, and the weighbridge figure — the number
 * a diversion certificate is built from — was never stored.
 *
 * Nothing caught it. The service suite fakes `driverRepository`, so the real
 * schema was never exercised; a mocked repository will accept any field name you
 * hand it, which is exactly the class of bug a mock cannot see.
 *
 * The first test below needs no database and is the real guard: it compares the
 * repository's field names against the schema's. The second proves the round
 * trip where a Mongo is available.
 */

describe('the tip-off write matches its schema', () => {
  /*
   * A pure introspection check, so it runs everywhere — on a laptop with no
   * database and in CI. If someone renames a schema path without following it
   * through to the repository, this fails before anything reaches production.
   */
  it('defines every path the driver repository writes', () => {
    const schema = RunTipOffModel.schema;

    for (const path of ['runId', 'netKg', 'docketNumber', 'docketPhotoKey', 'tippedOffAt']) {
      expect(schema.path(path), `RunTipOff is missing "${path}"`).toBeDefined();
    }
  });

  /*
   * The names the WIRE uses. They differ from the schema's on purpose, and the
   * repository translates between them — but a schema that started answering to
   * the wire names would mean the translation had been quietly undone somewhere,
   * and two spellings of the same field is how the original bug hid.
   */
  it('does not also answer to the contract field names', () => {
    const schema = RunTipOffModel.schema;

    for (const path of ['totalKg', 'docketReference', 'docketPhotoId']) {
      expect(schema.path(path), `"${path}" is the wire name and must not be a schema path`).toBeUndefined();
    }
  });

  /*
   * `facility` is required on the office's path but cannot be on the driver's:
   * the Tip-off screen has no facility picker. If it were required again, every
   * driver tip-off would be refused.
   */
  it('does not require a facility, which the driver screen never asks for', () => {
    expect(RunTipOffModel.schema.path('facility')?.isRequired).toBeFalsy();
  });
});

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_tipoff_test';

let reachable = false;

beforeAll(async () => {
  try {
    // `dbName`, not a path segment: MONGODB_URI may already name a database,
    // and appending one builds an invalid namespace rather than overriding it.
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
  if (reachable) await RunTipOffModel.deleteMany({});
});

describe('recordTipOff, against a real database', () => {
  const runId = new mongoose.Types.ObjectId().toHexString();
  const driverId = new mongoose.Types.ObjectId().toHexString();

  const docket = {
    runId,
    driverId,
    date: '2026-09-08',
    totalKg: 2940,
    docketReference: 'WB-449288',
    docketPhotoKey: 'runs/abc/dockets/x.jpg',
    tippedOffAt: new Date('2026-09-08T15:40:00.000Z'),
  };

  it('stores the weighbridge figure where the run sheet reads it', async ({ skip }) => {
    if (!reachable) skip();

    await driverRepository.recordTipOff(docket);

    const row = await RunTipOffModel.findOne({
      runId: new mongoose.Types.ObjectId(runId),
    }).lean<{ netKg: number; docketNumber: string | null; docketPhotoKey: string | null }>();

    // The assertion the original bug would have failed: the number survives.
    expect(row?.netKg).toBe(2940);
    expect(row?.docketNumber).toBe('WB-449288');
    expect(row?.docketPhotoKey).toBe('runs/abc/dockets/x.jpg');
  });

  it('accepts a docket with no photo, so tip-off is not blocked on one', async ({ skip }) => {
    if (!reachable) skip();

    await driverRepository.recordTipOff({ ...docket, docketPhotoKey: null });

    const row = await RunTipOffModel.findOne({
      runId: new mongoose.Types.ObjectId(runId),
    }).lean<{ netKg: number; docketPhotoKey: string | null }>();

    expect(row?.netKg).toBe(2940);
    expect(row?.docketPhotoKey).toBeNull();
  });

  it('upserts, so a replayed docket does not become a second one', async ({ skip }) => {
    if (!reachable) skip();

    await driverRepository.recordTipOff(docket);
    await driverRepository.recordTipOff({ ...docket, totalKg: 3100 });

    const rows = await RunTipOffModel.find({
      runId: new mongoose.Types.ObjectId(runId),
    }).lean<Array<{ netKg: number }>>();

    // One docket per run (Matt, 43:50) — two would make the split ambiguous.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.netKg).toBe(3100);
  });
});

/**
 * That what the driver writes, the office can still READ.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * `RunTipOffSchema.facility` was `NonEmptyStringSchema`, and the driver path
 * writes null — there is no facility picker on the Tip-off screen, and the
 * repository says as much. The API does not validate its own responses, so it
 * happily served `facility: null`; the web client parses with this schema and
 * threw. The result was that the allocator’s dispatch board showed
 * "Something went wrong" for the WHOLE DAY as soon as any driver weighed off —
 * triggered by the most routine end-of-day action in the product.
 *
 * The persistence tests above prove the write lands. This proves the other
 * half: that the shape it lands in is one the reading side accepts.
 */
describe('the board contract accepts a driver-recorded tip-off', () => {
  it('allows a null facility, because the driver is never asked for one', () => {
    const parsed = RunTipOffSchema.safeParse({
      facility: null,
      docketNumber: 'WB-0001',
      netKg: 4200,
      tippedOffAt: '2026-09-11T05:10:00.000Z',
      docketPhotoUrl: 'http://localhost:4000/storage/plastago%2Fruns%2Fx%2Fdockets%2Fy.jpg',
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('still accepts the office path, which does name a facility', () => {
    const parsed = RunTipOffSchema.safeParse({
      facility: 'Cleanaway Erskine Park',
      docketNumber: 'D138485',
      netKg: 6062,
      tippedOffAt: '2026-09-11T05:43:00.000Z',
      docketPhotoUrl: null,
    });

    expect(parsed.success).toBe(true);
  });

  it('still refuses an empty facility, which is a blank field and not an absent one', () => {
    const parsed = RunTipOffSchema.safeParse({
      facility: '',
      docketNumber: null,
      netKg: 100,
      tippedOffAt: '2026-09-11T05:43:00.000Z',
      docketPhotoUrl: null,
    });

    expect(parsed.success).toBe(false);
  });
});
