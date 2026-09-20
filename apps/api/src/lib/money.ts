import type { Money } from '@plastago/shared';
import { Types } from 'mongoose';

/**
 * Money, at the storage boundary.
 *
 * ── The rule this file exists to enforce ──────────────────────────────────
 * §6A.10 #1: money is `Decimal128` in Mongo and a decimal STRING on the wire.
 * It is never a JavaScript `number`, anywhere, at any point.
 *
 * A JSON number is an IEEE-754 double. `0.1 + 0.2` is `0.30000000000000004`,
 * and the same class of error applied to a per-m² rate over 240 jobs a month is
 * a reconciliation nobody can close. The figures here have to match TransVirtual
 * to the cent (Risk 1), which is a bar floats cannot clear.
 *
 * ── Why arithmetic happens in integer cents ───────────────────────────────
 * Decimal128 is exact but awkward to compute with in JS. So the pattern
 * throughout is: parse to integer cents → do the arithmetic in whole numbers →
 * format back to a decimal string. Integers are exact up to 2^53, which is
 * ninety trillion dollars — comfortably more than PlastaGo will invoice.
 */

/** The wire format: `"220.00"`. Four decimal places allowed, two are normal. */
export function centsToMoney(cents: number): Money {
  if (!Number.isFinite(cents)) throw new TypeError('Money must be a finite number of cents');

  const rounded = Math.round(cents);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);

  return `${negative ? '-' : ''}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * A decimal string to integer cents, for arithmetic.
 *
 * Rejects anything that is not a decimal string rather than coercing: a silent
 * `NaN` here becomes a zero on an invoice, and a zero on an invoice is money
 * nobody ever chases.
 */
export function moneyToCents(value: Money): number {
  if (!/^-?\d+(\.\d{1,4})?$/.test(value)) {
    throw new TypeError(`Not a decimal money string: ${JSON.stringify(value)}`);
  }

  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');

  // Padded then truncated to exactly two places. A rate stored with four
  // decimals is a RATE, not an amount — amounts are cents.
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return negative ? -cents : cents;
}

/** Storage format. The only way a monetary value should enter a Mongo document. */
export function toDecimal128(value: Money): Types.Decimal128 {
  if (!/^-?\d+(\.\d{1,4})?$/.test(value)) {
    throw new TypeError(`Not a decimal money string: ${JSON.stringify(value)}`);
  }
  return Types.Decimal128.fromString(value);
}

/**
 * Storage format back to the wire.
 *
 * Normalised to two decimal places so `"220"` and `"220.0"` both leave as
 * `"220.00"` — a UI that has to cope with three spellings of the same amount
 * grows formatting logic that belongs here.
 */
export function fromDecimal128(value: Types.Decimal128 | null | undefined): Money {
  if (value === null || value === undefined) return '0.00';
  return centsToMoney(moneyToCents(value.toString()));
}

/**
 * Move a figure by a signed amount, keeping a RATE's precision.
 *
 * ── Why this cannot go through `moneyToCents` ─────────────────────────────
 * That truncates to two places, which is right for an amount and destructive
 * for a rate: shifting `0.1625` would silently store `0.16`, and the four
 * decimals exist precisely because rounding a per-m² rate before multiplying by
 * 823.41 m² loses real money on every large job. So the arithmetic happens in
 * TEN-THOUSANDTHS, which holds every value either kind can carry.
 *
 * ⚠️ Clamped at zero. This shifts copied rate rows when a new zone is created,
 * and an over-large negative adjustment would otherwise write a rate that bills
 * the customer a negative amount — the exact failure `NonNegativeMoneySchema`
 * exists to prevent on the way in.
 */
export function shiftMoney(value: Money, delta: Money): Money {
  const shifted = toTenThousandths(value) + toTenThousandths(delta);
  return fromTenThousandths(Math.max(shifted, 0));
}

function toTenThousandths(value: Money): number {
  if (!/^-?\d+(\.\d{1,4})?$/.test(value)) {
    throw new TypeError(`Not a decimal money string: ${JSON.stringify(value)}`);
  }

  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = Number(whole) * 10_000 + Number(fraction.padEnd(4, '0'));
  return negative ? -units : units;
}

/** Four decimal places, always — `Decimal128` keeps them and the reader needs them. */
function fromTenThousandths(units: number): Money {
  const rounded = Math.round(units);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  return `${negative ? '-' : ''}${String(Math.floor(abs / 10_000))}.${String(abs % 10_000).padStart(4, '0')}`;
}

/**
 * A rate, which is not an amount.
 *
 * `$0.16` per m² has to survive at its own precision — rounding it to cents
 * before multiplying by 823.41 m² loses real money over a month. Rates are
 * therefore kept as decimal strings and only the RESULT is rounded to cents.
 */
export function applyRate(rate: Money, quantity: number): number {
  if (!/^-?\d+(\.\d{1,4})?$/.test(rate)) {
    throw new TypeError(`Not a decimal rate string: ${JSON.stringify(rate)}`);
  }
  if (!Number.isFinite(quantity)) throw new TypeError('Quantity must be a finite number');

  // The rate is scaled to ten-thousandths first so the multiply happens in
  // integers, then divided back down — never `Number(rate) * quantity`.
  const [whole = '0', fraction = ''] = rate.replace('-', '').split('.');
  const scaled = Number(whole) * 10_000 + Number(fraction.padEnd(4, '0').slice(0, 4));
  const signed = rate.startsWith('-') ? -scaled : scaled;

  // → cents: (rate × 10⁴) × qty ÷ 10⁴ × 100 = ×100 ÷ 10⁴ = ÷100.
  return Math.round((signed * quantity) / 100);
}
