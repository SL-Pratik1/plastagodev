import { normaliseMobile, toE164Mobile } from '@plastago/shared';
import { describe, expect, it } from 'vitest';

/**
 * I2 — the two mobile formats, and why both exist.
 *
 * ── The bug this guards ───────────────────────────────────────────────────
 * PlastaGo stores mobiles in Australian local form (`0412345678`) because that
 * is what people type, what an operator recognises, and what the unique index
 * on the users collection is built from. Twilio accepts only E.164 and answers
 * anything else with error 21211.
 *
 * For a while nothing converted between them, so every driver sign-in SMS
 * failed — and SMS is a driver's ONLY way into the app (§9 A2). It was
 * invisible while `SMS_PROVIDER=stub`, because the stub prints whatever it is
 * given and never complains. It surfaced the moment real credentials landed.
 *
 * So: `normaliseMobile` owns the storage form, `toE164Mobile` owns the wire
 * form, and neither may quietly become the other.
 */

describe('normaliseMobile — the STORAGE form', () => {
  it('reduces every way a person types a mobile to one local form', () => {
    for (const typed of [
      '0412345678',
      '0412 345 678',
      '(04) 1234 5678',
      '04-1234-5678',
      '+61412345678',
      '+61 412 345 678',
      '61412345678',
    ]) {
      expect(normaliseMobile(typed)).toBe('0412345678');
    }
  });
});

describe('toE164Mobile — the WIRE form', () => {
  it('converts the stored form to what Twilio will accept', () => {
    expect(toE164Mobile('0412345678')).toBe('+61412345678');
  });

  it('accepts anything a user could have typed, not just the stored form', () => {
    for (const typed of ['0412 345 678', '+61412345678', '61412345678', '(04) 1234 5678']) {
      expect(toE164Mobile(typed)).toBe('+61412345678');
    }
  });

  it('is idempotent, so a value that went through twice is still valid', () => {
    // Worth pinning: a second pass creeping in somewhere must not produce
    // `+61+61…`, which fails at Twilio with the same opaque 21211.
    expect(toE164Mobile(toE164Mobile('0412345678'))).toBe('+61412345678');
  });

  it('drops the trunk zero exactly once', () => {
    // `0455112233` — the seeded driver, and the number that exposed the bug.
    expect(toE164Mobile('0455112233')).toBe('+61455112233');
    expect(toE164Mobile('0455112233')).not.toContain('+610');
  });

  it('leaves a non-Australian number alone rather than guessing a prefix', () => {
    /*
     * A wrong guess is worse than a rejection: prefixing an unknown number
     * with +61 can deliver a sign-in code to a stranger's handset. Returning
     * it untouched makes Twilio refuse it with a clear error instead.
     */
    expect(toE164Mobile('+14155552671')).toBe('+14155552671');
    expect(toE164Mobile('not-a-number')).toBe('notanumber');
  });

  it('does not mistake a landline for a mobile', () => {
    // AU mobiles are 04xx. A Sydney landline must not be silently converted
    // and then charged for as an undeliverable SMS.
    expect(toE164Mobile('0298765432')).toBe('0298765432');
  });
});
