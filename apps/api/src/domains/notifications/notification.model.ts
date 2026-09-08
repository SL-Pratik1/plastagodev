import { NOTIFICATION_CATEGORIES, NOTIFICATION_SEVERITIES } from '@plastago/shared';
import { Schema, model } from 'mongoose';

export const NOTIFICATIONS_COLLECTION = 'notifications';
export const OUTBOUND_MESSAGES_COLLECTION = 'outboundmessages';

/**
 * The internal notification centre (M8.7).
 *
 * ── What lands here, and what deliberately does not ───────────────────────
 * Things that need SOMEBODY TO ACT: a futile review nobody has decided, a
 * charge nobody has approved, an invoice waiting on a PO, a driver's phone that
 * has not synced. §6A.8 adds the last one because there is no error-tracking
 * vendor — a stuck offline queue has to be visible in the product itself.
 *
 * NOT here: the customer-facing SMS and email from M8.1/M8.2. Those go OUT to
 * customers; they do not belong in an office inbox. They are recorded in
 * `outboundmessages` below, which is a delivery log, not a worklist.
 *
 * ⚠️ The reason this screen exists at all: one futile pickup has sat unactioned
 * in TransVirtual since 28 August 2025 — a year, at $120. The system has to
 * chase, because nobody did.
 */
const notificationSchema = new Schema(
  {
    /**
     * REFERENCE → `users._id`. Who this is for.
     *
     * Per user rather than one shared list, because read state is per person:
     * Renee marking something read must not hide it from Priya, who still has
     * to act on it.
     */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    category: { type: String, required: true, enum: NOTIFICATION_CATEGORIES },

    /**
     * Drives ordering as much as colour.
     *
     * ⚠️ `action` means somebody has to do something; `info` is a record. A
     * centre where everything is urgent trains people to ignore it, so `urgent`
     * is reserved for things that stop work — an unroadworthy truck, a driver
     * who walked off a site.
     */
    severity: { type: String, required: true, enum: NOTIFICATION_SEVERITIES, default: 'info' },

    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    at: { type: Date, required: true, default: Date.now },
    readAt: { type: Date, default: null },

    /**
     * Where acting on it happens.
     *
     * ⚠️ Every notification must be actionable. One that tells somebody a
     * problem exists without saying where to fix it is a notification they
     * learn to dismiss.
     */
    href: { type: String, required: true, trim: true },

    /** Shown on queue notifications, because the amount IS the argument. */
    valueExGst: { type: Schema.Types.Decimal128, default: null },

    /* ── Deep links back to whatever raised it ───────────────────────── */
    jobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    jobNumber: { type: Number, default: null, min: 1 },

    /**
     * What this notification is ABOUT, as a stable key.
     *
     * ⚠️ The de-duplication handle. A nightly digest that ran twice, or a queue
     * still holding the same row tomorrow, must not produce a second copy —
     * a centre that repeats itself is one nobody reads. Shaped
     * `futile-review:<reviewId>` or `digest:2026-09-08`.
     */
    subjectKey: { type: String, required: true, trim: true },
  },
  { collection: NOTIFICATIONS_COLLECTION, timestamps: true, versionKey: false },
);

/**
 * ⚠️ One notification per subject per user.
 *
 * The guard against the same futile review being announced every night for a
 * month. Re-raising updates the existing row instead.
 */
notificationSchema.index(
  { userId: 1, subjectKey: 1 },
  { unique: true, name: 'user_subject_unique' },
);

/** The inbox: newest first, for one person. */
notificationSchema.index({ userId: 1, at: -1 }, { name: 'user_recent' });

/**
 * The badge count. Partial, so the index holds only what is unread — which is
 * a handful of rows rather than every notification ever raised.
 */
notificationSchema.index(
  { userId: 1, severity: 1 },
  { name: 'user_unread', partialFilterExpression: { readAt: null } },
);

export const NotificationModel = model('Notification', notificationSchema);

/**
 * M8.1 / M8.2 — a message actually sent to a customer or a driver.
 *
 * ── Why sends are logged at all ───────────────────────────────────────────
 * Because "did they get the reminder?" is the first question asked when a site
 * is not ready, and "we sent it" has to be checkable rather than assumed. It is
 * also how a failed send becomes visible: the provider stub and the real vendor
 * both fail sometimes, and a send nobody recorded is one nobody retries.
 *
 * ⚠️ A LOG, not a queue. Nothing reads this to decide what to send next — the
 * sending happens inline and this records what happened.
 */
const outboundMessageSchema = new Schema(
  {
    /** Which rule raised it — `job-completed`, `pickup-reminder`. */
    event: { type: String, required: true, trim: true },
    channel: { type: String, required: true, enum: ['email', 'sms'] },

    /**
     * The address it went to, REDACTED.
     *
     * `a••••••••@example.com`. This collection would otherwise become a second
     * copy of every customer contact detail in the system, sitting in a place
     * nobody thinks of as sensitive.
     */
    toMasked: { type: String, required: true, trim: true },

    subject: { type: String, required: false, default: '', trim: true },

    /* ── What it was about ───────────────────────────────────────────── */
    accountId: { type: Schema.Types.ObjectId, default: null, ref: 'Account' },
    jobId: { type: Schema.Types.ObjectId, default: null, ref: 'Job' },
    invoiceId: { type: Schema.Types.ObjectId, default: null, ref: 'Invoice' },

    sentAt: { type: Date, required: true, default: Date.now },
    outcome: { type: String, required: true, enum: ['sent', 'failed', 'skipped'] },
    /** Why it failed, or why it was skipped — "no email on file". */
    detail: { type: String, default: null, trim: true },

    /**
     * The same de-duplication handle as above.
     *
     * ⚠️ A reminder sent twice is worse than one sent late: the customer stops
     * reading them. Shaped `pickup-reminder:<jobId>`.
     */
    subjectKey: { type: String, required: true, trim: true },
  },
  { collection: OUTBOUND_MESSAGES_COLLECTION, timestamps: true, versionKey: false },
);

/** One send per subject per channel. See the warning above. */
outboundMessageSchema.index(
  { subjectKey: 1, channel: 1 },
  { unique: true, name: 'subject_channel_unique' },
);

/** "What did we send this customer?" — the question support actually asks. */
outboundMessageSchema.index({ accountId: 1, sentAt: -1 }, { name: 'account_sent' });
outboundMessageSchema.index({ jobId: 1, sentAt: -1 }, { name: 'job_sent' });

/** The failure sweep. Partial, because most sends succeed. */
outboundMessageSchema.index(
  { sentAt: -1 },
  { name: 'failures', partialFilterExpression: { outcome: 'failed' } },
);

export const OutboundMessageModel = model('OutboundMessage', outboundMessageSchema);
