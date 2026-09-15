import { MoneySchema, NonNegativeMoneySchema, PoConfirmationSchema } from '@plastago/shared';
import { describe, expect, it } from 'vitest';

/**
 * Money on the wire, and where a minus sign is allowed.
 *
 * ⚠️ `MoneySchema` permits a leading minus, which is right for a figure the
 * system COMPUTES — a reconciliation variance is genuinely negative sometimes.
 * It was also being used on request bodies, and there a negative is not a credit
 * but a typo: confirming a purchase order at `-100.00` returned 204 and wrote a
 * real order for minus a hundred dollars. Credit notes are explicitly v1.1 and
 * unmodelled, so nothing in this version has any business accepting one.
 */
describe('money on the wire', () => {
  it('is a decimal string, never a float', () => {
    expect(MoneySchema.safeParse(220).success).toBe(false);
    expect(MoneySchema.safeParse('220.00').success).toBe(true);
  });

  it('caps the scale at four places', () => {
    expect(MoneySchema.safeParse('220.0000').success).toBe(true);
    expect(MoneySchema.safeParse('220.00000').success).toBe(false);
  });

  /* Responses keep it, so a computed figure can still be shown as what it is. */
  it('still allows a negative, for figures the system computes', () => {
    expect(MoneySchema.safeParse('-100.00').success).toBe(true);
  });
});

describe('money that cannot sensibly be negative', () => {
  it('takes an ordinary amount', () => {
    expect(NonNegativeMoneySchema.safeParse('1250.00').success).toBe(true);
  });

  /* Zero is NOT the same as negative: a purchase order can carry no figure yet. */
  it('allows zero', () => {
    expect(NonNegativeMoneySchema.safeParse('0.00').success).toBe(true);
  });

  it('refuses a negative', () => {
    expect(NonNegativeMoneySchema.safeParse('-100.00').success).toBe(false);
    expect(NonNegativeMoneySchema.safeParse('-0.01').success).toBe(false);
  });

  it('says so in words the office can act on', () => {
    const result = NonNegativeMoneySchema.safeParse('-100.00');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        'Must be a decimal amount like "220.00", and never negative',
      );
    }
  });

  it('is still a string, not a number', () => {
    expect(NonNegativeMoneySchema.safeParse(1250).success).toBe(false);
  });
});

describe('confirming a purchase order', () => {
  const base = {
    poNumber: 'PO-98819',
    accountId: '6aa394f52a29583bc57aa33c',
    jobId: null,
    expectedAreaM2: 500,
    bagAllowance: 4,
    lotNumber: '12',
    addressLine: '12 Test Road',
    suburb: 'Medowie',
    siteSupervisorName: 'Dave Nguyen',
    siteSupervisorMobile: '0412345678',
    amountExGst: '1250.00',
  };

  it('takes a real order', () => {
    expect(PoConfirmationSchema.safeParse(base).success).toBe(true);
  });

  /* The regression this file exists for. */
  it('refuses an order for a negative amount', () => {
    expect(PoConfirmationSchema.safeParse({ ...base, amountExGst: '-100.00' }).success).toBe(false);
  });

  /*
   * Null is not zero and neither is a typo: the amount is genuinely absent on
   * plenty of orders, and that has to stay bookable.
   */
  it('still allows no amount at all', () => {
    expect(PoConfirmationSchema.safeParse({ ...base, amountExGst: null }).success).toBe(true);
  });
});
