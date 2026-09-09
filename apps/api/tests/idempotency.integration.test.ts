import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/error-handler.js';
import { idempotency } from '../src/middleware/idempotency.js';
import { IdempotencyKeyModel } from '../src/middleware/idempotency.model.js';

/**
 * Replay protection (`docs/offline-sync-protocol.md` §3), against a real Mongo.
 *
 * The whole mechanism is a unique index and a captured response, and neither
 * exists without a database — a mocked model would happily accept two inserts of
 * the same key and prove nothing. The scenario being defended is a driver's
 * phone retrying a queued `futile` report it never saw the answer to, and
 * raising a second $120 charge against a customer who was only failed once.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_idempotency_test';

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_KEY = '5a1b2c3d-4e5f-4a1b-8c2d-9e0f1a2b3c4d';

let reachable = false;
/** How many times the handler behind the middleware actually ran. */
let handled = 0;

const app = express();
app.use(express.json());
// Stands in for `requireAuth`: the middleware scopes keys per user.
app.use((req, _res, next) => {
  req.auth = {
    userId: (req.get('x-test-user') ?? 'user-a'),
    name: 'Troy Holm',
    roles: ['driver'],
    accountId: null,
  } as never;
  next();
});
app.use(idempotency);
app.post('/charge', (_req, res) => {
  handled += 1;
  res.status(201).json({ chargeId: 'chg_1', amount: 120 });
});
app.post('/no-content', (_req, res) => {
  handled += 1;
  res.status(204).send();
});
app.post('/boom', (_req, res) => {
  handled += 1;
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'nope', requestId: 'r' } });
});
app.use(errorHandler);

beforeAll(async () => {
  try {
    // `dbName`, not a path segment: MONGODB_URI may already name a database,
    // and appending one builds an invalid namespace rather than overriding it.
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    reachable = true;
    await IdempotencyKeyModel.syncIndexes();
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
  handled = 0;
  if (reachable) await IdempotencyKeyModel.deleteMany({});
});

describe('idempotency', () => {
  it('runs the handler once and replays the same response', async ({ skip }) => {
    if (!reachable) skip();

    const first = await request(app)
      .post('/charge')
      .set('idempotency-key', KEY)
      .send({ jobId: 'j1', reason: 'site-closed' })
      .expect(201);

    const second = await request(app)
      .post('/charge')
      .set('idempotency-key', KEY)
      .send({ jobId: 'j1', reason: 'site-closed' })
      .expect(201);

    // The point of the whole mechanism: one charge, not two.
    expect(handled).toBe(1);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('replays a 204 as a 204, not as an empty 200', async ({ skip }) => {
    if (!reachable) skip();

    await request(app).post('/no-content').set('idempotency-key', KEY).send({ a: 1 }).expect(204);
    await request(app).post('/no-content').set('idempotency-key', KEY).send({ a: 1 }).expect(204);

    expect(handled).toBe(1);
  });

  it('refuses a key reused with a different body', async ({ skip }) => {
    if (!reachable) skip();

    await request(app).post('/charge').set('idempotency-key', KEY).send({ jobId: 'j1' }).expect(201);

    // A client bug, and the dangerous kind: replaying the first answer would
    // discard this write and report success.
    const clash = await request(app)
      .post('/charge')
      .set('idempotency-key', KEY)
      .send({ jobId: 'j2' })
      .expect(409);

    expect(handled).toBe(1);
    expect(clash.body.error.code).toBe('CONFLICT');
  });

  it('scopes keys per driver, so two drivers can generate the same one', async ({ skip }) => {
    if (!reachable) skip();

    await request(app)
      .post('/charge')
      .set('idempotency-key', KEY)
      .set('x-test-user', 'user-a')
      .send({ jobId: 'j1' })
      .expect(201);

    await request(app)
      .post('/charge')
      .set('idempotency-key', KEY)
      .set('x-test-user', 'user-b')
      .send({ jobId: 'j1' })
      .expect(201);

    // Both ran: one driver's key must never replay another's response back.
    expect(handled).toBe(2);
  });

  it('releases the key when the handler fails, so a retry can succeed', async ({ skip }) => {
    if (!reachable) skip();

    await request(app).post('/boom').set('idempotency-key', KEY).send({ a: 1 }).expect(500);

    // A failure is not a completed operation. Pinning the 500 to this key would
    // make a transient outage permanent for that queued action.
    const row = await IdempotencyKeyModel.findOne({ key: KEY }).lean();
    expect(row).toBeNull();
  });

  it('passes through a request with no key', async ({ skip }) => {
    if (!reachable) skip();

    await request(app).post('/charge').send({ jobId: 'j1' }).expect(201);
    await request(app).post('/charge').send({ jobId: 'j1' }).expect(201);

    // The office console does not queue writes and sends no key; refusing it
    // would break that surface for no gain.
    expect(handled).toBe(2);
  });

  it('rejects a key that is not a UUID v4', async ({ skip }) => {
    if (!reachable) skip();

    const response = await request(app)
      .post('/charge')
      .set('idempotency-key', 'not-a-uuid')
      .send({ a: 1 })
      // 422, not 400: `AppError.validation` is what every schema failure in
      // this API answers with, and a client branching on 400 would miss it.
      .expect(422);

    expect(handled).toBe(0);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('keeps separate keys separate', async ({ skip }) => {
    if (!reachable) skip();

    await request(app).post('/charge').set('idempotency-key', KEY).send({ a: 1 }).expect(201);
    await request(app).post('/charge').set('idempotency-key', OTHER_KEY).send({ a: 2 }).expect(201);

    expect(handled).toBe(2);
  });
});
