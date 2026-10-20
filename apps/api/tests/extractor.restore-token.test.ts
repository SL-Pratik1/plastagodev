import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractorResult } from '../src/integrations/extractor.js';

/**
 * I6 — carrying the tenant's existing embed token onto a database that has none.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * Three properties, each guarding a credential nobody can re-issue cheaply:
 *
 *  1. **It never replaces.** A row on file is a live credential; this path only
 *     ever fills an empty collection.
 *  2. **It proves before it writes.** The vendor must accept the token AS the
 *     owner first, so a typo cannot be stored and then fail every page load.
 *  3. **The token never comes back.** The answer goes to a browser console.
 */

const TOKEN = `ext_${'a'.repeat(48)}`;
const OWNER = 'platform@plastago.com.au';
const CALLER = { userId: '6ac633aef0fe7a62452bfa77', name: 'Test SuperAdmin' };

let stored: Record<string, unknown> | null = null;
let inserted: Array<Record<string, unknown>> = [];
let insertResult = true;
let enabled = true;
let vendorCalls: Array<{ email: string; token: string }> = [];
let vendorAnswer: ExtractorResult<{ sessionId: string; expiresAt: number }>;
let order: string[] = [];

vi.mock('../src/domains/extractor/extractor.repository.js', () => ({
  extractorRepository: {
    findToken: () => Promise.resolve(stored),
    insertToken: (input: Record<string, unknown>) => {
      order.push('insert');
      inserted.push(input);
      return Promise.resolve(insertResult);
    },
  },
}));

vi.mock('../src/integrations/extractor.js', async (importOriginal) => {
  // The real classifiers, so the prose they read is the prose under test.
  const actual = await importOriginal<typeof import('../src/integrations/extractor.js')>();
  return {
    ...actual,
    extractorClient: {
      get enabled() {
        return enabled;
      },
      createSessionWithToken: (email: string, token: string) => {
        order.push('vendor');
        vendorCalls.push({ email, token });
        return Promise.resolve(vendorAnswer);
      },
    },
  };
});

const { extractorService } = await import('../src/domains/extractor/extractor.service.js');
const { RestoreEmbedTokenSchema } = await import('../src/domains/extractor/extractor.schemas.js');

const restore = () => extractorService.restoreToken({ token: TOKEN, ownerEmail: OWNER }, CALLER);

beforeEach(() => {
  stored = null;
  inserted = [];
  insertResult = true;
  enabled = true;
  vendorCalls = [];
  order = [];
  vendorAnswer = { ok: true, value: { sessionId: 'ses_1', expiresAt: Date.now() + 86_400_000 } };
});

describe('restoring the key onto an empty database', () => {
  it('saves it under the same tenant and app the broker reads', async () => {
    const result = await restore();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      tenantId: 'plastago',
      appName: 'plastago-admin',
      token: TOKEN,
      ownerEmail: OWNER,
    });
    expect(result).toMatchObject({ saved: true, ownerEmail: OWNER });
  });

  it('proves the key AS the owner before writing anything', async () => {
    await restore();

    expect(vendorCalls).toEqual([{ email: OWNER, token: TOKEN }]);
    expect(order).toEqual(['vendor', 'insert']);
  });

  it('never hands the key back', async () => {
    expect(JSON.stringify(await restore())).not.toContain(TOKEN);
  });
});

describe('what it refuses', () => {
  it('never replaces a key already on file — and does not even ask the vendor', async () => {
    stored = { token: 'ext_live', ownerEmail: OWNER };

    await expect(restore()).rejects.toMatchObject({ status: 409 });
    expect(vendorCalls).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('a lost race is a conflict, not a raw database error', async () => {
    insertResult = false;

    await expect(restore()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses when the extractor is switched off', async () => {
    enabled = false;

    await expect(restore()).rejects.toMatchObject({ status: 503 });
    expect(vendorCalls).toHaveLength(0);
  });
});

describe('when the vendor says no, nothing is written and the reason is named', () => {
  it('a key the vendor does not recognise', async () => {
    vendorAnswer = { ok: false, status: 401, detail: 'Invalid embed token' };

    await expect(restore()).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('did not accept this key') as unknown,
    });
    expect(inserted).toHaveLength(0);
  });

  it('an owner email that is not in the tenant', async () => {
    vendorAnswer = { ok: false, status: 404, detail: `User with email '${OWNER}' not found` };

    await expect(restore()).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('owner email') as unknown,
    });
    expect(inserted).toHaveLength(0);
  });

  /*
   * The vendor answers a bad app secret with 401 as well. Calling that "a wrong
   * key" would send the person to re-copy a key that was fine all along.
   */
  it("this server's own app secret, named as such", async () => {
    vendorAnswer = { ok: false, status: 401, detail: 'Invalid app secret' };

    await expect(restore()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('EXTRACTOR_APP_SECRET') as unknown,
    });
    expect(inserted).toHaveLength(0);
  });

  it('an outage', async () => {
    vendorAnswer = { ok: false, status: 500, detail: 'upstream exploded' };

    await expect(restore()).rejects.toMatchObject({ status: 503 });
    expect(inserted).toHaveLength(0);
  });
});

describe('the request body', () => {
  it('takes a key and an owner email, tidied', () => {
    const parsed = RestoreEmbedTokenSchema.parse({
      token: `  ${TOKEN}  `,
      ownerEmail: ' Platform@PlastaGo.com.au ',
    });

    expect(parsed).toEqual({ token: TOKEN, ownerEmail: OWNER });
  });

  it('refuses a stub key or a missing owner', () => {
    expect(RestoreEmbedTokenSchema.safeParse({ token: 'ext_', ownerEmail: OWNER }).success).toBe(
      false,
    );
    expect(RestoreEmbedTokenSchema.safeParse({ token: TOKEN }).success).toBe(false);
    expect(RestoreEmbedTokenSchema.safeParse({ token: TOKEN, ownerEmail: 'nope' }).success).toBe(
      false,
    );
  });
});
