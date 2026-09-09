import { describe, expect, it } from 'vitest';
import { meansNotAMember, meansStaleToken } from '../src/integrations/extractor.js';

/**
 * I6 — classifying the two recoverable session failures.
 *
 * ── Why this is worth a test of its own ───────────────────────────────────
 * Because both branches read the vendor's PROSE, and prose changes without a
 * version bump. When a classifier stops matching, nothing crashes: the branch
 * simply never runs, and the failure it existed to repair is reported to the
 * office as "the extractor is unavailable". That is the quietest possible way
 * for this integration to break.
 *
 * The strings below are the ones the live service actually returned, not
 * paraphrases. `User with email '…' not found` is the one that caught out an
 * earlier `detail.includes('user not found')`: the vendor interpolates the
 * address into the middle of the sentence, so the phrase never appears.
 */

describe('a user who is not yet a member of the tenant', () => {
  it('recognises the message the live service returns, address and all', () => {
    expect(
      meansNotAMember({
        status: 404,
        detail: "User with email 'matt@plastago.com.au' not found",
      }),
    ).toBe(true);
  });

  it('recognises the shorter forms too', () => {
    expect(meansNotAMember({ status: 404, detail: 'User not found' })).toBe(true);
    expect(meansNotAMember({ status: 403, detail: 'Not a member of this tenant' })).toBe(true);
  });

  /*
   * The provisioning branch adds somebody to a tenant. Firing it on an
   * unrelated fault would create members in response to, say, a missing
   * extraction — so the status is part of the test, not just the prose.
   */
  it('does not fire on a status that means something else', () => {
    expect(meansNotAMember({ status: 500, detail: 'User not found' })).toBe(false);
    expect(meansNotAMember({ status: 401, detail: 'User not found' })).toBe(false);
  });

  it('does not fire on a different missing thing', () => {
    expect(meansNotAMember({ status: 404, detail: 'Extraction not found' })).toBe(false);
    expect(meansNotAMember({ status: 404, detail: 'Document not found' })).toBe(false);
  });
});

describe('an embed token the vendor no longer recognises', () => {
  it('recognises each wording the guide documents', () => {
    expect(meansStaleToken({ status: 404, detail: 'Embed token not found' })).toBe(true);
    expect(meansStaleToken({ status: 401, detail: 'No active embed token' })).toBe(true);
    expect(meansStaleToken({ status: 401, detail: 'Invalid embed token' })).toBe(true);
  });

  /*
   * ⚠️ The two classifiers must not both claim the same failure. Re-onboarding
   * in response to a missing USER would mint a second tenant, and the recovery
   * order in the service means whichever matches first wins.
   */
  it('does not claim a missing user', () => {
    expect(
      meansStaleToken({
        status: 404,
        detail: "User with email 'matt@plastago.com.au' not found",
      }),
    ).toBe(false);
  });
});
