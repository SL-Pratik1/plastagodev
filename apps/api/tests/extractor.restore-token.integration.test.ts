import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmbedTokenModel } from '../src/domains/extractor/extractor.model.js';
import { extractorRepository } from '../src/domains/extractor/extractor.repository.js';

/**
 * `insertToken` is the "never replace" promise of the token restore, and that
 * promise is kept by Mongo's unique index, not by our code — so it is tested
 * against a real Mongo. A fake would agree with whatever it was handed. Skips
 * where there is no Mongo.
 */

const MONGO_URL = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const TEST_DB = 'plastago_restore_token_test';

let reachable = false;

beforeAll(async () => {
  try {
    await mongoose.connect(MONGO_URL, { dbName: TEST_DB, serverSelectionTimeoutMS: 2000 });
    await EmbedTokenModel.init(); // the unique index this whole test leans on
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
  if (reachable) await EmbedTokenModel.deleteMany({});
});

const row = (token: string) => ({
  tenantId: 'plastago',
  appName: 'plastago-admin',
  token,
  appId: 'app_1',
  ownerEmail: 'platform@plastago.com.au',
});

describe('insertToken', () => {
  it('stores a row the broker can read back', async (ctx) => {
    if (!reachable) return ctx.skip();

    expect(await extractorRepository.insertToken(row('ext_first'))).toBe(true);

    expect(await extractorRepository.findToken('plastago', 'plastago-admin')).toMatchObject({
      token: 'ext_first',
      ownerEmail: 'platform@plastago.com.au',
      appId: 'app_1',
    });
  });

  it('never replaces a row already there — answers false instead', async (ctx) => {
    if (!reachable) return ctx.skip();

    await extractorRepository.insertToken(row('ext_first'));

    expect(await extractorRepository.insertToken(row('ext_second'))).toBe(false);
    expect((await extractorRepository.findToken('plastago', 'plastago-admin'))?.token).toBe(
      'ext_first',
    );
    expect(await EmbedTokenModel.countDocuments()).toBe(1);
  });
});
