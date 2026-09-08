import { LEAD_SOURCES, LEAD_STATUSES, ZONES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const LEADS_COLLECTION = 'leads';
export const LEAD_NOTES_COLLECTION = 'leadnotes';
export const LEAD_ATTACHMENTS_COLLECTION = 'leadattachments';

/**
 * A lead (M5, Journey A).
 *
 * ── Why leads are a separate thing from accounts at all ───────────────────
 * Because before this existed, a builder who rang 1300 395 438 either lived in
 * somebody's notebook or was typed straight in as a JOB — which is the "leads
 * arrive disguised as jobs" problem the whole journey was built to end. A job
 * implies a rate card, an account and terms; an enquiry implies none of those,
 * and forcing one into the other shape is what made the pipeline invisible.
 *
 * A lead is a sales record. It becomes an account only through A.4, which is
 * where the rate card, the terms and the customer code are decided.
 */
const leadSchema = new Schema(
  {
    companyName: { type: String, required: true, trim: true },
    contactName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    /** A lead can legitimately be email-only — the grid renders "Email only". */
    mobile: { type: String, default: null, trim: true },

    /**
     * ⚠️ Every lead starts `new`, and intake cannot set this.
     *
     * Letting it be chosen at creation would allow a lead to be created already
     * `won`, which bypasses A.4 — and so bypasses the rate card, the terms and
     * the account that "won" is supposed to mean.
     */
    status: { type: String, required: true, enum: LEAD_STATUSES, default: 'new' },
    source: { type: String, required: true, enum: LEAD_SOURCES },

    /**
     * A.2 infers the zone from a postcode. There is no postcode → zone lookup in
     * this build, so it is asked for rather than guessed.
     *
     * Null is a REAL answer, not a missing one: it means a lead PlastaGo
     * probably cannot service, which the queue filters for on purpose.
     */
    zone: { type: String, enum: ZONES, default: null },
    suburbs: { type: String, required: false, default: '', trim: true },

    /** Nullable rather than 0 — "they did not say" is not "no plasterboard". */
    typicalVolumeM2: { type: Number, default: null, min: 0 },
    expectedFrequency: { type: String, required: false, default: '', trim: true },
    heardAbout: { type: String, required: false, default: '', trim: true },

    /** Who is chasing it. A name, so it survives the owner leaving. */
    ownerName: { type: String, default: null, trim: true },
    /** REFERENCE → `users._id`, where the owner is a real login. */
    ownerUserId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },

    /**
     * The clock the pipeline ages against.
     *
     * Not `updatedAt`: that moves when anything at all is written, including a
     * background backfill. This moves when a HUMAN did something, which is the
     * question "what have we not touched in three weeks" is really asking.
     */
    lastActivityAt: { type: Date, required: true, default: Date.now },

    /**
     * REFERENCE → `accounts._id`, set once A.4 has run.
     *
     * A converted lead is history, not work — it leaves the queue but stays
     * readable, because "what did we quote them" is asked long after.
     */
    convertedAccountId: { type: Schema.Types.ObjectId, default: null, ref: 'Account' },
    convertedAt: { type: Date, default: null },
  },
  { collection: LEADS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * The pipeline: open leads, least recently touched first.
 *
 * Partial on `convertedAccountId` being absent, so the index holds only leads
 * still in play rather than every enquiry PlastaGo has ever had.
 */
leadSchema.index(
  { status: 1, lastActivityAt: 1 },
  { name: 'open_pipeline', partialFilterExpression: { convertedAccountId: null } },
);

leadSchema.index({ zone: 1, status: 1 }, { name: 'zone_status' });

/**
 * Duplicate detection, not a constraint.
 *
 * The same builder can legitimately enquire twice — a year apart, or for a
 * different division — so this is NOT unique. It exists so the office can be
 * shown "you already have a lead for this company" before creating a second.
 */
leadSchema.index({ email: 1 }, { name: 'email' });

leadSchema.index(
  { companyName: 'text', contactName: 'text', email: 'text', suburbs: 'text' },
  { name: 'lead_search' },
);

export const LeadModel = model('Lead', leadSchema);

/**
 * One entry in a lead's note thread.
 *
 * Its own collection rather than an array: a lead accumulates notes over months
 * of chasing, and the thread is the actual sales record — what was said, when,
 * by whom. An array would be rewritten in full to append one line, and could
 * not be queried on its own.
 */
const leadNoteSchema = new Schema(
  {
    /** REFERENCE → `leads._id`. */
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead' },
    at: { type: Date, required: true, default: Date.now },
    /** REFERENCE → `users._id`, plus the name frozen for the record. */
    authorId: { type: Schema.Types.ObjectId, default: null, ref: 'User' },
    author: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
  },
  { collection: LEAD_NOTES_COLLECTION, timestamps: true, versionKey: false },
);

leadNoteSchema.index({ leadId: 1, at: 1 }, { name: 'lead_at' });

export const LeadNoteModel = model('LeadNote', leadNoteSchema);

/**
 * A file attached to a lead — in practice, a PDF proposal.
 *
 * Matt, 5:53: *"if we're able to attach like a PDF file to those leads… we do
 * generate PDF proposals for some builders and it would help us keep track of
 * that."*
 *
 * ⚠️ Append-and-remove, never edit-in-place. The lead is a sales record and the
 * file is evidence of what was OFFERED — a proposal that can be silently
 * swapped is not evidence of anything. There is deliberately no update path.
 */
const leadAttachmentSchema = new Schema(
  {
    /** REFERENCE → `leads._id`. */
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead' },
    fileName: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    contentType: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
    uploadedBy: { type: String, required: true, trim: true },
    /** Where the bytes live in object storage. The API never holds the file. */
    storageKey: { type: String, required: true },
  },
  { collection: LEAD_ATTACHMENTS_COLLECTION, timestamps: true, versionKey: false },
);

leadAttachmentSchema.index({ leadId: 1, uploadedAt: 1 }, { name: 'lead_uploaded' });

export const LeadAttachmentModel = model('LeadAttachment', leadAttachmentSchema);
