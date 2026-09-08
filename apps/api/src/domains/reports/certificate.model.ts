import { CERTIFICATE_SCOPES, CERTIFICATE_STATES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const CERTIFICATES_COLLECTION = 'certificates';

/**
 * M9.5 · F52 — a Certificate of Recycling.
 *
 * ── Why this is stored and not computed on demand ─────────────────────────
 * Because it is a DOCUMENT, not a view. These go into builders' Green Star and
 * NABERS submissions, and the figure on the copy a customer filed last March
 * has to still say what it said last March — even after a late tip-off
 * reconciliation moves the underlying weights.
 *
 * So issuing one FREEZES its numbers. A certificate recomputed at read time
 * would quietly disagree with the PDF somebody already submitted to an auditor,
 * which is the one failure this record exists to prevent.
 *
 * ⚠️ The tonnage is the RECOVERED weight from the tip-off reconciliation
 * (M4.4) — never derived from the m² used for pricing. Those are two different
 * quantities: m² is the board installed, kg is what came back on the truck.
 */
const certificateSchema = new Schema(
  {
    /**
     * The number quoted in a submission — "PG-CERT-2026-0041".
     *
     * Human-readable and unique, because an auditor referring back to one needs
     * something they can read off a printed page.
     */
    reference: { type: String, required: true, trim: true },

    scope: { type: String, required: true, enum: CERTIFICATE_SCOPES },
    /**
     * `draft` until somebody issues it.
     *
     * A draft can be regenerated freely as more jobs complete; an issued one
     * cannot change at all. That is the whole point of the two states.
     */
    state: { type: String, required: true, enum: CERTIFICATE_STATES, default: 'draft' },

    /** REFERENCE → `accounts._id`. Who it is for. */
    accountId: { type: Schema.Types.ObjectId, required: true, ref: 'Account' },
    /** Frozen copy — the certificate must read the same in five years. */
    accountName: { type: String, required: true, trim: true },

    /** Set when the scope narrows to one site or one job. */
    siteName: { type: String, default: null, trim: true },
    /** REFERENCE → `jobs._id`, on a single-job certificate. */
    jobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    jobNumber: { type: Number, default: null, min: 1 },

    periodFrom: { type: String, required: true },
    periodTo: { type: String, required: true },

    /* ── The figures, frozen at issue ────────────────────────────────── */
    jobs: { type: Number, required: true, min: 0, default: 0 },

    /**
     * ⚠️ Null where no job in scope has a recorded area.
     *
     * A fixed-price builder's POs carry none (Matt, 31:04), and the certificate
     * is still valid — the figure that matters is the tonnage, which comes off
     * the weighbridge. A zero here would claim they installed no plasterboard.
     */
    areaM2: { type: Number, default: null, min: 0 },

    /**
     * The number the whole document exists for.
     *
     * Matt's own wording: *"Your job of X amount of square metres had X amount
     * of waste, and that has been successfully diverted from landfill."* Both
     * figures appear; only this one is auditable.
     */
    tonnesDiverted: { type: Number, required: true, min: 0, default: 0 },

    /* ── Issue ───────────────────────────────────────────────────────── */
    issuedAt: { type: Date, default: null },
    /** The email address it went to. Often the sustainability team (31:04). */
    issuedTo: { type: String, default: null, trim: true },
    issuedByName: { type: String, default: null, trim: true },

    /** REFERENCE → the generated PDF in object storage. Null until rendered. */
    storageKey: { type: String, default: null },
  },
  { collection: CERTIFICATES_COLLECTION, timestamps: true, versionKey: false },
);

/** The reference an auditor quotes. A duplicate would be unresolvable. */
certificateSchema.index({ reference: 1 }, { unique: true, name: 'reference_unique' });

/** One account's certificates, newest first — the portal's only query. */
certificateSchema.index({ accountId: 1, periodTo: -1 }, { name: 'account_period' });

/** The office's list, and the drafts still waiting to be issued. */
certificateSchema.index({ state: 1, createdAt: -1 }, { name: 'state_created' });

/**
 * ⚠️ At most ONE certificate per job.
 *
 * Two certificates for one pickup would let the same tonnage be claimed twice
 * in two different Green Star submissions. Partial, because `jobId` is null on
 * every account- and period-scoped certificate.
 */
certificateSchema.index(
  { jobId: 1 },
  {
    unique: true,
    name: 'job_unique',
    partialFilterExpression: { jobId: { $type: 'objectId' } },
  },
);

export const CertificateModel = model('Certificate', certificateSchema);
