import { Schema, model } from 'mongoose';

export const XERO_CONNECTIONS_COLLECTION = 'xeroconnections';
export const XERO_OAUTH_STATES_COLLECTION = 'xerooauthstates';

/**
 * The Xero connection (I1 · M7.8).
 *
 * ── Why this is a database record and not configuration ───────────────────
 * Every other integration's credential is an environment variable, because it
 * is a credential PlastaGo owns and a deploy is the right way to change it.
 * This one is different in kind: it is minted at runtime when the organisation
 * owner approves us, it belongs to THEM, and — the part that settles the
 * argument — Xero rotates the refresh token on every single refresh. A value
 * that changes every thirty minutes cannot live in `.env`.
 *
 * ── Why a singleton ───────────────────────────────────────────────────────
 * There is one PlastaGo and it invoices from one set of books. A user can
 * authorise several Xero organisations at once, and the service deliberately
 * narrows that to the one chosen — see `xero.service.ts`. Modelling it as a
 * collection of connections would suggest invoices can be routed between
 * organisations, which is a decision nothing in this platform is equipped to
 * make and which would silently split a customer's ledger in two.
 */
const xeroConnectionSchema = new Schema(
  {
    /** Fixed, so there can only ever be one connection document. */
    _id: { type: String, default: 'singleton' },

    /**
     * The Xero ORGANISATION id. Goes in the `Xero-tenant-id` header on every
     * accounting call, and identifies which books we are writing to.
     */
    tenantId: { type: String, required: true, trim: true },

    /**
     * The Xero CONNECTION id — a different value from `tenantId`, and the one
     * `DELETE /connections/{id}` wants.
     *
     * ⚠️ Confusing the two is the classic bug here: disconnect appears to
     * succeed, Xero ignores it, and PlastaGo stays listed as a connected app
     * forever. They are stored separately so neither can stand in for the other.
     */
    connectionId: { type: String, required: true, trim: true },

    /** Shown on the page, so Matthew can see WHICH company is connected. */
    tenantName: { type: String, required: true, trim: true },

    /**
     * ⚠️ Both tokens are sealed by `lib/secret-box.ts`, never plain.
     *
     * These grant standing access to a customer's accounting records. A Mongo
     * backup, a shared Compass window or a support-session dump should not be
     * a leaked ledger — see the reasoning in that module.
     */
    accessTokenSealed: { type: String, required: true },
    refreshTokenSealed: { type: String, required: true },

    /** When the ACCESS token dies. Minutes away, refreshed on demand. */
    accessExpiresAt: { type: Date, required: true },

    /**
     * When the REFRESH token dies if never used — Xero's sixty-day window.
     *
     * Stored so the page can warn before the connection lapses rather than
     * reporting it afterwards. A connection that quietly stopped syncing three
     * weeks ago is discovered at month-end, which is the worst possible time.
     */
    refreshExpiresAt: { type: Date, required: true },

    /**
     * `connected`  — working.
     * `needs-reconnect` — Xero rejected the grant. Only a human can fix it,
     *                     so retries are pointless and the page says so.
     */
    status: {
      type: String,
      required: true,
      enum: ['connected', 'needs-reconnect'],
      default: 'connected',
    },

    /** Why it needs reconnecting, for the page. Null while healthy. */
    statusMessage: { type: String, default: null },

    /** Who authorised it, for the audit trail and for the page's byline. */
    connectedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    connectedByName: { type: String, required: true, trim: true },
    connectedAt: { type: Date, required: true },

    /** Last successful refresh, so a stuck cycle is visible on the page. */
    lastRefreshAt: { type: Date, default: null },
  },
  { timestamps: true, collection: XERO_CONNECTIONS_COLLECTION },
);

export const XeroConnectionModel = model('XeroConnection', xeroConnectionSchema);

/**
 * One in-flight authorisation attempt.
 *
 * ── What this prevents ────────────────────────────────────────────────────
 * Without it, `GET /xero/callback` accepts any code any caller presents. An
 * attacker who can get a signed-in admin to load one crafted URL connects
 * PlastaGo's invoicing to an organisation THEY control — every invoice the
 * business raises then flows into a stranger's books. The `state` value is the
 * proof that the callback answers a request this server actually started.
 *
 * ── Why a collection rather than a cookie or memory ───────────────────────
 * A cookie would work and is the usual answer, but the callback arrives as a
 * top-level cross-site navigation from Xero, where `SameSite=Lax` cookies are
 * sent and `Strict` ones are not — a distinction that has quietly broken this
 * exact flow in other codebases. In-process memory fails the moment the API
 * runs as more than one instance, which is the deployed shape. A row is
 * boring, survives both, and expires on its own.
 */
const xeroOAuthStateSchema = new Schema(
  {
    /** The random value echoed back by Xero. Indexed unique — it is the key. */
    state: { type: String, required: true, trim: true },

    /**
     * Who started it. The callback runs as an unauthenticated top-level
     * navigation, so this row is the ONLY record of which admin to attribute
     * the connection to.
     */
    startedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startedByName: { type: String, required: true, trim: true },

    /**
     * Mongo deletes the row itself once this passes.
     *
     * Ten minutes is long enough for somebody to find their Xero password and
     * short enough that a `state` captured from a browser history is useless by
     * the time it is found. TTL rather than a sweep because an expiry nobody
     * runs is not an expiry.
     */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: XERO_OAUTH_STATES_COLLECTION },
);

xeroOAuthStateSchema.index({ state: 1 }, { unique: true, name: 'state_unique' });

/*
 * `expireAfterSeconds: 0` means "delete when `expiresAt` passes" rather than
 * "delete N seconds after it". Mongo's TTL monitor runs about once a minute,
 * so a row can outlive its stamp briefly — which is why the service checks the
 * date itself instead of trusting the row's existence.
 */
xeroOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'state_ttl' });

export const XeroOAuthStateModel = model('XeroOAuthState', xeroOAuthStateSchema);
