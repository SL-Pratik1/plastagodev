import { AbnSchema, isValidAbn } from '@plastago/shared';
import { describe, expect, it } from 'vitest';

/**
 * The ABN checksum.
 *
 * ⚠️ Every writable `abn` field used to be `/^\d{11}$/` and nothing more, so
 * `11111111111` was accepted onto an account — and the ABN reaches a tax
 * invoice, where a wrong one becomes the customer's problem to explain to their
 * accountant. Eleven digits is a shape, not a check.
 *
 * The valid numbers below are real, publicly listed ABNs, because a checksum
 * test written against numbers the implementation produced would pass whatever
 * the implementation did.
 */
describe('ABN validation', () => {
  const VALID = [
    '51824753556', // the ATO's own worked example
    '53004085616',
  ];

  const INVALID = [
    '11111111111', // right length, fails the checksum
    '12345678901',
    '00000000000',
    '5182475355', // ten digits
    '518247535566', // twelve
    'ABCDEFGHIJK',
    '',
  ];

  for (const abn of VALID) {
    it(`accepts ${abn}`, () => {
      expect(isValidAbn(abn)).toBe(true);
      expect(AbnSchema.safeParse(abn).success).toBe(true);
    });
  }

  for (const abn of INVALID) {
    it(`rejects ${JSON.stringify(abn)}`, () => {
      expect(isValidAbn(abn)).toBe(false);
      expect(AbnSchema.safeParse(abn).success).toBe(false);
    });
  }

  /*
   * An ABN is printed "51 824 753 556" on every letterhead it appears on.
   * Asking somebody to retype it without the spaces is a pointless way to
   * manufacture a validation error.
   */
  it('accepts the spaced form it is printed in, and stores it without spaces', () => {
    const parsed = AbnSchema.safeParse('51 824 753 556');
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toBe('51824753556');
  });

  it('explains itself when the checksum fails', () => {
    const parsed = AbnSchema.safeParse('11111111111');
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toMatch(/not a valid ABN/i);
  });
});
