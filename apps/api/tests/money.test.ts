import { describe, expect, it } from 'vitest';
import {
  applyRate,
  centsToMoney,
  fromDecimal128,
  moneyToCents,
  toDecimal128,
} from '../src/lib/money.js';

/**
 * Money handling (§6A.10 #1).
 *
 * These are the tests that matter most in the whole API. Every figure PlastaGo
 * invoices passes through this file, and the requirement is not "close" — the
 * output has to match TransVirtual to the cent (Risk 1). A float error here is
 * a reconciliation nobody can close, discovered a month later.
 */

describe('cents ↔ decimal string', () => {
  it('formats whole and part dollars', () => {
    expect(centsToMoney(22000)).toBe('220.00');
    expect(centsToMoney(1)).toBe('0.01');
    expect(centsToMoney(0)).toBe('0.00');
    expect(centsToMoney(-4550)).toBe('-45.50');
  });

  it('round-trips without drift', () => {
    for (const value of ['0.00', '0.01', '220.00', '1234.56', '-45.50', '99999.99']) {
      expect(centsToMoney(moneyToCents(value))).toBe(value);
    }
  });

  /*
   * The whole point. `0.1 + 0.2 === 0.30000000000000004` as floats; as cents it
   * is exactly 30.
   */
  it('adds without float error', () => {
    const total = moneyToCents('0.10') + moneyToCents('0.20');
    expect(centsToMoney(total)).toBe('0.30');
  });

  it('refuses anything that is not a decimal string', () => {
    // A silent NaN here becomes a zero on an invoice, and a zero on an invoice
    // is money nobody ever chases.
    expect(() => moneyToCents('abc')).toThrow();
    expect(() => moneyToCents('')).toThrow();
    expect(() => moneyToCents('1.2.3')).toThrow();
    expect(() => moneyToCents('$220.00')).toThrow();
  });
});

describe('Decimal128 at the storage boundary', () => {
  it('round-trips through Mongo’s type', () => {
    expect(fromDecimal128(toDecimal128('823.41'))).toBe('823.41');
    expect(fromDecimal128(toDecimal128('0.16'))).toBe('0.16');
  });

  it('normalises how the same amount is spelled', () => {
    // "220", "220.0" and "220.00" are one amount. A UI that has to cope with
    // three spellings grows formatting logic that belongs in this file.
    expect(fromDecimal128(toDecimal128('220'))).toBe('220.00');
    expect(fromDecimal128(toDecimal128('220.0'))).toBe('220.00');
  });

  it('treats a missing amount as zero rather than crashing a render', () => {
    expect(fromDecimal128(null)).toBe('0.00');
    expect(fromDecimal128(undefined)).toBe('0.00');
  });
});

describe('applying a per-m² rate', () => {
  /*
   * Matt's own worked example, from the Domain purchase order: 823.41 m² at the
   * Sydney rate. This is the number that lands on a real invoice.
   */
  it('prices Matt’s Domain job correctly', () => {
    const area = applyRate('0.16', 823.41);
    expect(centsToMoney(area)).toBe('131.75');

    const total = moneyToCents('220.00') + area;
    expect(centsToMoney(total)).toBe('351.75');
  });

  it('keeps rate precision that rounding to cents would lose', () => {
    // $0.16 rounded to cents first, then multiplied, drifts over a month.
    // 1000 m² × $0.1650 is $165.00 exactly — not $160.00.
    expect(centsToMoney(applyRate('0.1650', 1000))).toBe('165.00');
  });

  it('handles the zone rates verbatim', () => {
    expect(centsToMoney(applyRate('0.16', 1000))).toBe('160.00'); // Sydney
    expect(centsToMoney(applyRate('0.18', 1000))).toBe('180.00'); // Wollongong
    expect(centsToMoney(applyRate('0.20', 1000))).toBe('200.00'); // Newcastle
  });

  it('is exact at zero and refuses nonsense', () => {
    expect(centsToMoney(applyRate('0.16', 0))).toBe('0.00');
    expect(() => applyRate('abc', 100)).toThrow();
    expect(() => applyRate('0.16', Number.NaN)).toThrow();
  });
});
