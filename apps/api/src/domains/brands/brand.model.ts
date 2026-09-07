import { BRAND_IDS, BRAND_LABELS, type BrandId } from '@plastago/shared';
import { Schema, model, type InferSchemaType } from 'mongoose';

export const BRANDS_COLLECTION = 'brands';

/**
 * Brand (M1.1) — a first-class dimension, not a setting.
 *
 * ── Why this is a collection, and why its `_id` is a slug ───────────────────
 * A brand has attributes of its own: a display name, a palette, an ABN, a
 * trading name on an invoice, and eventually an invoice template (M7.4).
 * Copying those into every user and every job would be duplication of exactly
 * the kind that referencing exists to prevent — change EasyLift's ABN and you
 * would have to rewrite three years of documents.
 *
 * So brand data lives here once, and `users.brandIds` / `jobs.brandId` hold a
 * reference to it.
 *
 * The `_id` is the slug (`"plastago"`), not an ObjectId. That is a deliberate
 * choice, not a shortcut:
 *
 *  1. **It is still a real foreign key.** `_id` is `_id`; a slug primary key
 *     joins, indexes and validates exactly like an ObjectId one. The point of
 *     referencing — one copy of the data, pointed at from many places — is
 *     fully satisfied.
 *  2. **The contract already fixes these three values.** `BrandIdSchema` in
 *     `@plastago/shared` is `z.enum(['plastago','easylift','brickgo'])`, and the
 *     Flutter app pins that contract (§6A.9). Switching to ObjectIds would be a
 *     breaking change to a frozen schema, for no behavioural gain.
 *  3. **A brand is read on nearly every screen and never renamed.** A slug
 *     makes a job document self-describing in the shell and in a log line,
 *     which an opaque ObjectId does not.
 *
 * If brands ever become user-creatable, this `_id` becomes an ObjectId and the
 * shared enum becomes `ObjectIdSchema` — one migration, in one place, because
 * nothing embeds brand data.
 */
const brandSchema = new Schema(
  {
    /** The slug. Primary key, and the value that appears in every reference. */
    _id: {
      type: String,
      required: true,
      enum: BRAND_IDS,
    },
    label: { type: String, required: true, trim: true },
    /** Legal entity on invoices. Null until the client supplies it (Q register). */
    abn: { type: String, default: null },
    tradingName: { type: String, default: null },
    /**
     * EasyLift is operationally live today; BrickGo is not yet trading. An
     * inactive brand stays referenced by historical jobs but is not offered on
     * a new one.
     */
    active: { type: Boolean, required: true, default: true },
  },
  {
    collection: BRANDS_COLLECTION,
    timestamps: true,
    // `_id` is supplied explicitly, so Mongoose must not cast it to ObjectId.
    _id: false,
    versionKey: false,
  },
);

export type BrandDocument = InferSchemaType<typeof brandSchema>;

export const BrandModel = model('Brand', brandSchema);

/**
 * The three brands the contract names, as documents.
 *
 * Seeded rather than migrated because the set is fixed by the shared enum: if a
 * fourth appears, `BRAND_IDS` changes first and this follows automatically.
 */
export function brandSeedData(): Array<{ _id: BrandId; label: string; active: boolean }> {
  return BRAND_IDS.map((id) => ({
    _id: id,
    label: BRAND_LABELS[id],
    // BrickGo is in the contract but not yet trading (M1.1).
    active: id !== 'brickgo',
  }));
}
