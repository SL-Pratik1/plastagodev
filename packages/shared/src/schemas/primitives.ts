import * as z from 'zod';

/** A 24-character hex Mongo ObjectId, as it appears on the wire. */
export const ObjectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex ObjectId')
  .meta({ id: 'ObjectId', description: 'Mongo ObjectId', example: '66b3f0c1a2d4e5f6a7b8c9d0' });

/** UTC instant, ISO-8601. Stored UTC, rendered Australia/Sydney (§6A.10 #5). */
export const IsoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .meta({ id: 'IsoDateTime', example: '2026-08-25T01:30:00.000Z' });

/** Calendar date with no time component (ready dates, target dates). */
export const IsoDateSchema = z.iso.date().meta({ id: 'IsoDate', example: '2026-08-25' });

/**
 * A monetary amount on the wire.
 *
 * Money is `Decimal128` in Mongo and NEVER a float (§6A.10 #1). Across HTTP it
 * travels as a decimal STRING so no JSON number rounding can touch it. Parse it
 * into a decimal type at the edges — never into `number`.
 */
export const MoneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Must be a decimal string, e.g. "220.00"')
  .meta({ id: 'Money', description: 'Decimal string. Never a float.', example: '220.00' });

/**
 * The ATO's check on an ABN: subtract 1 from the first digit, weight each digit,
 * and the total must divide by 89.
 *
 * Exported so it can be unit-tested against real numbers rather than only
 * exercised through a form.
 */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

export function isValidAbn(value: string): boolean {
  const digits = value.replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;

  const total = ABN_WEIGHTS.reduce(
    (sum, weight, index) => sum + (Number(digits[index]) - (index === 0 ? 1 : 0)) * weight,
    0,
  );

  return total % 89 === 0;
}

/**
 * An Australian Business Number.
 *
 * ⚠️ Eleven digits is NOT the check. Every writable `abn` field used to be
 * `/^\d{11}$/` alone, so `11111111111` was accepted — and an ABN reaches a tax
 * invoice, where a wrong one is the customer's problem to explain to their
 * accountant. The checksum catches a transposed or mistyped digit, which is the
 * way this goes wrong in practice.
 *
 * Spaces are tolerated on the way in because ABNs are written "51 824 753 556"
 * everywhere they are printed, and re-typing one without them is a pointless
 * thing to ask of somebody reading it off a letterhead.
 */
export const AbnSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s/g, ''))
  .refine((value) => /^\d{11}$/.test(value), 'An ABN is 11 digits')
  .refine(isValidAbn, 'That is not a valid ABN — check it on ABN Lookup')
  .meta({ id: 'Abn', description: '11 digits, ATO checksum valid.', example: '51824753556' });

/** Trimmed, non-empty free text. */
export const NonEmptyStringSchema = z.string().trim().min(1);

/** An idempotency key supplied by an offline client when replaying a queued action. */
export const IdempotencyKeySchema = z
  .string()
  .uuid()
  .meta({ id: 'IdempotencyKey', description: 'Client-generated UUID v4 for safe retries' });

export type ObjectId = z.infer<typeof ObjectIdSchema>;
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type IsoDate = z.infer<typeof IsoDateSchema>;
export type Money = z.infer<typeof MoneySchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
