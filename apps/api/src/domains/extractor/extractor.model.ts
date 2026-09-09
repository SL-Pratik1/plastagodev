import { Schema, model, type InferSchemaType } from 'mongoose';

export const EMBED_TOKENS_COLLECTION = 'embedtokens';
export const EXTRACTOR_SESSIONS_COLLECTION = 'extractorsessions';

/**
 * The two caches behind the Extractor tab (I6).
 *
 * ⚠️ Both are CACHES. The extractor is the source of truth for every value in
 * this file, and a row here that disagrees with the vendor is wrong by
 * definition — which is why the service deletes rows rather than repairing
 * them, and why nothing else in PlastaGo is allowed to read them.
 *
 * ── Why cache at all ──────────────────────────────────────────────────────
 * Because a session is minted per page load. Without a cache, opening the tab
 * five times in a morning is five round trips to a third party before anything
 * renders, and a vendor outage becomes a blank tab rather than a stale-but-
 * working one.
 */

/**
 * One embed token per tenant, shared by every user in it.
 *
 * ── Why a collection and not just `EXTRACTOR_EMBED_TOKEN` ─────────────────
 * The env var is the token this deployment was onboarded with, and it works.
 * What it cannot do is survive a rotation: if the token is revoked at the
 * vendor, env still holds the dead one and only a redeploy fixes it. A row can
 * be deleted and re-minted by the running process, which is what
 * `meansStaleToken` recovery does.
 *
 * PlastaGo is single-tenant today, so this holds exactly one document. It is
 * keyed by tenant anyway because the alternative — a singleton row — is the
 * shape that has to be migrated the day a second brand needs its own extractor
 * tenant, and keying it now costs one index.
 */
const embedTokenSchema = new Schema(
  {
    /**
     * PlastaGo's own tenant discriminator, NOT the vendor's tenant id.
     *
     * Single-tenant today, so every row carries `'plastago'`. Held as a string
     * rather than an ObjectId because there is no tenants collection to
     * reference — inventing one to satisfy a foreign key would be worse than
     * naming the thing.
     */
    tenantId: { type: String, required: true, trim: true },

    /**
     * Which host application this token belongs to, matching the Application
     * name registered in the extractor's admin dashboard. Stored so a second
     * PlastaGo surface (the portal, say) can hold its own token without
     * colliding with this one.
     */
    appName: { type: String, required: true, trim: true },

    /** ⚠️ A live credential. Never returned to a browser; see the controller. */
    token: { type: String, required: true },

    /** The vendor's id for the token above, so a rotation can target it. */
    tokenId: { type: String, default: null },

    /** The vendor's tenant id, from onboarding. Diagnostic only. */
    organizationId: { type: String, default: null },

    /** The vendor application this token was minted against. */
    appId: { type: String, default: null },
  },
  { collection: EMBED_TOKENS_COLLECTION, timestamps: true, versionKey: false },
);

/** One token per tenant per host app. The upsert key. */
embedTokenSchema.index({ tenantId: 1, appName: 1 }, { unique: true, name: 'embed_token_unique' });

export type EmbedTokenDocument = InferSchemaType<typeof embedTokenSchema>;

export const EmbedTokenModel = model('EmbedToken', embedTokenSchema);

/**
 * One cached extractor session per tenant + user pair.
 *
 * ── Why per user and not per tenant ───────────────────────────────────────
 * Because a session carries an identity, and the extractor's own activity log
 * attributes uploads and template edits to it. One shared session would record
 * every action in the tenant against one name, which is exactly the property
 * an activity log exists to provide.
 */
const extractorSessionSchema = new Schema(
  {
    tenantId: { type: String, required: true, trim: true },

    /** REFERENCE → `users._id`. Whose session this is. */
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },

    /**
     * The vendor's session id.
     *
     * ⚠️ This one value IS handed to the browser — it is the iframe's whole
     * credential. That is the design: it expires in a day, it is scoped to one
     * user, and it never reveals the embed token that minted it.
     */
    sessionId: { type: String, required: true },

    expiresAt: { type: Date, required: true },
  },
  { collection: EXTRACTOR_SESSIONS_COLLECTION, timestamps: true, versionKey: false },
);

/** The lookup, and the upsert key. */
extractorSessionSchema.index(
  { tenantId: 1, userId: 1 },
  { unique: true, name: 'extractor_session_unique' },
);

/**
 * Expired rows delete themselves.
 *
 * A session is worthless the moment it expires and this collection would
 * otherwise grow one row per user forever. `expireAfterSeconds: 0` means "drop
 * it once `expiresAt` has passed", which is Mongo's own TTL sweep rather than a
 * cron job somebody has to remember exists.
 */
extractorSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'session_ttl' });

export type ExtractorSessionDocument = InferSchemaType<typeof extractorSessionSchema>;

export const ExtractorSessionModel = model('ExtractorSession', extractorSessionSchema);
