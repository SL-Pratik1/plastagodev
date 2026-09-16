import 'dotenv/config';
import type { Surface } from '@plastago/shared';
import * as z from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env`
 * again. A missing or malformed variable fails the process immediately with a
 * readable message rather than surfacing as a null-pointer three screens deep.
 */
/**
 * Read before the schema, because the sign-in ceilings below depend on it.
 *
 * Deliberately NOT `env.NODE_ENV` — that value does not exist until this schema
 * has parsed, and a default cannot wait for its own object.
 */
const isDevelopment = (process.env.NODE_ENV ?? 'development') === 'development';

/**
 * The sign-in rate ceilings, which differ sharply between environments.
 *
 * ── Why development needs its own numbers ─────────────────────────────────
 * Production's limits are sized for a person: six codes an hour is generous for
 * somebody signing in, and each one costs an SMS. On a laptop they are actively
 * broken — signing in and out to check a screen is the whole job, six is reached
 * in about two minutes, and the developer is then locked out of their own app
 * for an hour by a message that reads like a bug. That happened.
 *
 * Exported as a function so both numbers are covered by a test rather than by a
 * ternary nobody reruns. Every value can still be overridden by setting the
 * variable explicitly.
 */
export function signInLimits(development: boolean): {
  sendsPerHourPerIdentifier: number;
  sendsPerIp: number;
  verifiesPerIp: number;
} {
  return development
    ? { sendsPerHourPerIdentifier: 200, sendsPerIp: 500, verifiesPerIp: 500 }
    : { sendsPerHourPerIdentifier: 6, sendsPerIp: 20, verifiesPerIp: 60 };
}

const LIMITS = signInLimits(isDevelopment);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Comma-separated browser-origin allowlist. Never `*` in production.
     *
     * ⚠️ This list does TWO jobs: the CORS allowlist, and Better Auth's
     * `trustedOrigins` (see `auth/better-auth.ts`). A surface missing from it is
     * therefore not merely refused a cross-origin fetch — it cannot sign anybody
     * in. One entry per surface, always.
     *
     * The default covers the three dev surfaces (§6A.5) plus the superseded
     * standalone driver app on 5174, which is still runnable.
     */
    CORS_ORIGINS: z
      .string()
      .default(
        'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://localhost:5176',
      )
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),

    /** MongoDB Atlas, ap-southeast-2 (Sydney) in every deployed environment (§6A.2). */
    MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/plastago_dev'),
    MONGODB_DB_NAME: z.string().min(1).optional(),

    /**
     * Queues are opt-in so the API boots on a machine with no Redis. Turn on once
     * Redis exists locally; always on in deployed environments.
     */
    ENABLE_QUEUES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

    /**
     * The per-IP ceiling on the sign-in routes, over 15 minutes.
     *
     * Sized separately from the global limiter because every request to those
     * routes can spend money on an SMS. The office sits behind ONE NAT address,
     * so this is a per-OFFICE ceiling rather than a per-person one — loose
     * enough for a Monday morning with everybody signing in at once.
     *
     * ⚠️ Development is far higher for the same reason as
     * `OTP_MAX_SENDS_PER_HOUR`: a developer and their own browser share one
     * address, and 20 is about ten minutes of testing.
     */
    OTP_SENDS_PER_IP: z.coerce.number().int().positive().default(LIMITS.sendsPerIp),
    OTP_VERIFIES_PER_IP: z.coerce.number().int().positive().default(LIMITS.verifiesPerIp),

    // ─── Authentication (§9, M1.5) ────────────────────────────────────────────

    /**
     * Signs session cookies and tokens. MUST be set in production — the default
     * below exists so a developer can clone and run, and is rejected outright
     * when NODE_ENV=production (see the superRefine at the bottom).
     */
    BETTER_AUTH_SECRET: z
      .string()
      .min(32, 'Must be at least 32 characters — generate with: openssl rand -hex 32')
      .default('dev-only-insecure-secret-do-not-ever-use-in-production'),

    /**
     * The API's own public origin. Better Auth uses it to scope cookies and to
     * build absolute URLs, so it must be the address the BROWSER reaches, not
     * the container's internal one.
     */
    AUTH_BASE_URL: z.string().url().default('http://localhost:4000'),

    /**
     * Session lifetime. Eight hours is a working day: an office user signs in
     * once each morning, and a driver's session outlives a full run without
     * lapsing mid-job — which on the driver surface would mean a queued write
     * with nowhere to go.
     */
    AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(720).default(8),

    /** Code lifetime. The sign-in screen's copy says "only valid for 5 minutes". */
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

    /** How long before "Send a new code" becomes available again. */
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(30),

    /** Wrong guesses allowed before the challenge is burned. */
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(5),

    /**
     * Codes any one identifier may request per hour, however many IPs are used.
     *
     * ── ⚠️ The default is much higher in development, on purpose ───────────
     * Six an hour is right in production: each code costs an SMS, and somebody
     * genuinely signing in needs one or two. It is hopeless on a laptop, where
     * signing in and out to check a screen is the whole job — six is reached in
     * about two minutes, and the developer is then locked out of their own app
     * for an hour with a message that reads like a bug.
     *
     * So development gets a working ceiling and production keeps the real one.
     * Set the variable explicitly to override either.
     */
    OTP_MAX_SENDS_PER_HOUR: z.coerce
      .number()
      .int()
      .positive()
      .default(LIMITS.sendsPerHourPerIdentifier),

    /**
     * ⚠️ SECURITY / UX trade-off, deliberately switchable.
     *
     * `true`  — an unrecognised identifier answers `IDENTIFIER_UNKNOWN`, so the
     *           sign-in screen can say "we don't recognise that email". Good for
     *           the demo and for a typing driver; also an enumeration oracle.
     * `false` — every request answers with an indistinguishable challenge and no
     *           message is sent. Nothing leaks. A typo simply never arrives.
     *
     * Forced OFF in production regardless of this value — see
     * `revealUnknownIdentifier` below.
     */
    AUTH_REVEAL_UNKNOWN_IDENTIFIER: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /**
     * ⚠️ SECURITY. Returns the sign-in code in the `POST /auth/otp/request`
     * response body.
     *
     * For a shared environment running `MAIL_PROVIDER=stub` and
     * `SMS_PROVIDER=stub`, where the code only ever reaches the server log: a
     * client developer building against it otherwise cannot sign in without
     * dashboard access to somebody else's hosting account.
     *
     * While it is on the code is NOT a second factor — anyone who can name an
     * identifier can sign in as that person. Defaults OFF, and is forced OFF in
     * production regardless of this value; see `revealOtpCode` below.
     */
    AUTH_REVEAL_OTP_CODE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // ─── Outbound channels (I5 email · I2 SMS) ────────────────────────────────

    /**
     * `stub` prints the message to the log instead of sending it, so the whole
     * OTP flow is walkable with no vendor account. Swapping to a real provider
     * is this variable plus its credentials — never a code change (§8).
     */
    MAIL_PROVIDER: z.enum(['stub', 'graph']).default('stub'),
    SMS_PROVIDER: z.enum(['stub', 'clicksend']).default('stub'),

    /** I5/I6 — one Entra app registration serves Mail.Send now and Mail.Read later. */
    MS_GRAPH_TENANT_ID: z.string().min(1).optional(),
    MS_GRAPH_CLIENT_ID: z.string().min(1).optional(),
    MS_GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
    /** The mailbox Graph sends AS, e.g. `noreply@plastago.com.au`. */
    MS_GRAPH_MAIL_SENDER: z.string().email().optional(),

    /** I2 — SMS to drivers and site supervisors. */
    CLICKSEND_USERNAME: z.string().min(1).optional(),
    /** The API key from Dashboard → API Credentials. NOT the account password. */
    CLICKSEND_API_KEY: z.string().min(1).optional(),
    /**
     * A dedicated number in E.164, or an approved alphanumeric sender id such
     * as `PlastaGo`.
     *
     * ⚠️ An alphanumeric sender cannot receive a reply. That is fine for every
     * message we send — none of them ask for one; where a reply would be
     * wanted, `notice-messages.ts` puts a phone number in the body instead.
     */
    CLICKSEND_FROM: z.string().min(1).optional(),

    /** Shown in the OTP message so the recipient knows who is asking. */
    OTP_SENDER_NAME: z.string().min(1).default('PlastaGo'),

    /**
     * Where a person lands when a message tells them to sign in.
     *
     * ── Why this is configuration and not derived from the request ─────────
     * The messages that carry it are sent from a worker and from background
     * sweeps, where there is no request to read an origin from. Deriving it from
     * `CORS_ORIGINS[0]` would work today and break the morning somebody
     * reorders that list — a link in an SMS is the one thing that cannot be
     * corrected after sending.
     *
     * ⚠️ Now the FALLBACK for the three surface URLs below, not the address
     * itself. It stays because a deployment that has not split its surfaces is
     * a valid deployment, and because every message this sends is uncorrectable
     * once sent — an unset variable must degrade to a working link, never to a
     * broken one.
     *
     * No trailing slash: every caller appends a path.
     */
    PUBLIC_APP_URL: z
      .string()
      .url()
      .default('http://localhost:5173')
      .transform((value) => value.replace(/\/+$/, '')),

    /**
     * The three surfaces, each at its own address (§6A.5).
     *
     * ── Why one URL could not stay one URL ────────────────────────────────
     * Because the paths built from it are not on the same surface. The Xero
     * callback returns the organisation owner to `/admin/xero` while a pickup
     * notice points a supervisor at `/portal/jobs/…`, and once the console and
     * the portal are different hostnames, one variable cannot be right for
     * both — whichever it names, the other half of the product is sending
     * people to an address that has no such page.
     *
     * Each defaults to `PUBLIC_APP_URL`, so a single-origin deployment needs
     * none of them and behaves exactly as it did before.
     */
    PUBLIC_ADMIN_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, '')),
    PUBLIC_PORTAL_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, '')),
    PUBLIC_DRIVER_URL: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.replace(/\/+$/, '')),

    /**
     * §6A.10 #9 — object storage for photos, dockets and generated PDFs.
     *
     * `stub` keeps the bytes on local disk and hands out ordinary API URLs, so
     * the whole capture-and-view path is walkable with no AWS account. Swapping
     * to S3 is this variable plus its credentials — never a code change (§8).
     */
    STORAGE_PROVIDER: z.enum(['stub', 's3']).default('stub'),

    S3_REGION: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    /**
     * The single folder every object lives under, e.g. `plastago/jobs/<id>/…`.
     *
     * ── Why a prefix rather than the bucket root ──────────────────────────
     * A bucket is rarely PlastaGo's alone — the one configured today is shared
     * test infrastructure. Rooting everything at one prefix means a lifecycle
     * rule, an IAM policy or a "delete everything of ours" can be written
     * against `plastago/*` without reaching a neighbour's objects, and it keeps
     * the console listing legible.
     *
     * Configurable rather than hard-coded so staging and production can share a
     * bucket without sharing objects (§8). Slashes are trimmed here so the one
     * place that joins it cannot produce `plastago//jobs` or a leading `/`,
     * either of which is a DIFFERENT and valid S3 key.
     */
    S3_KEY_PREFIX: z
      .string()
      .default('plastago')
      .transform((value) => value.replace(/^\/+|\/+$/g, '')),
    /**
     * Optional. Omit on EC2/ECS/Lambda so the SDK uses the instance role, which
     * is better than a long-lived key sitting in an environment variable.
     */
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** For S3-compatible storage (MinIO, R2). Left unset for real AWS. */
    S3_ENDPOINT: z.string().url().optional(),
    /**
     * How long an upload or view URL stays valid, in seconds.
     *
     * Short by default: a link that leaks is only useful while it is live, and
     * a driver's phone redeems an upload URL within seconds of asking for it.
     * Long enough that a poor 4G connection on a building site can still finish.
     */
    S3_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    /** Where the stub provider keeps bytes. Ignored when STORAGE_PROVIDER=s3. */
    STORAGE_STUB_DIR: z.string().min(1).default('.storage'),

    /**
     * I6 · M2.12 — the purchase-order extractor (3PM Extractor).
     *
     * `off` is the default and is a working state, not a broken one: the review
     * queue accepts extractions posted by hand, and the office keys purchase
     * orders in as it does today. Turning the pipeline on is this variable plus
     * credentials — never a code change (§8).
     *
     * ⚠️ The extractor also OWNS the mailbox connection. PlastaGo's own Graph
     * registration sends mail (I5) and deliberately does not read it: the
     * `Mail.Read` consent lives with the vendor that needs it, which is one
     * fewer permission on our own app.
     */
    EXTRACTOR_PROVIDER: z.enum(['off', 'threepm']).default('off'),

    EXTRACTOR_BASE_URL: z.string().url().default('https://extractor.decoded.digital'),
    EXTRACTOR_APP_ID: z.string().min(1).optional(),
    /** ⚠️ Never reaches a browser. Exchanged for a short-lived session id. */
    EXTRACTOR_APP_SECRET: z.string().min(1).optional(),
    /** From `POST /api/embed/onboard`, run once by `seed-extractor`. */
    EXTRACTOR_EMBED_TOKEN: z.string().min(1).optional(),
    /**
     * The account sessions are created for. A service identity, not a person —
     * a session minted under someone's own address would attribute every
     * ingested purchase order to them.
     */
    EXTRACTOR_USER_EMAIL: z.string().email().optional(),
    /**
     * The extractor's document template id, from `seed-extractor`.
     *
     * Optional: without it the webhook accepts every completed extraction in the
     * tenant. With it, anything raised against another template is ignored —
     * which matters as soon as the tenant is used for a second document type.
     */
    EXTRACTOR_DOCUMENT_ID: z.string().min(1).optional(),

    /**
     * The template id for CALL-UP emails (M2.12b), the second document type in
     * the same mailbox.
     *
     * Matt, 23:37: *"I've just created yesterday a new shared mailbox which is
     * builder doc processing, so all purchase orders and call-ups will go to the
     * same email address."* One mailbox, two kinds of document — so the template
     * the extractor matched is the only thing that tells them apart.
     *
     * ⚠️ Optional, and until it is set no call-up is ever read from an email.
     * That is the safe default: without it, a call-up extraction would fall
     * through to the purchase-order path and arrive as an order with no figures
     * on it. Booking still works by hand in the meantime (Matt, 30:40).
     */
    EXTRACTOR_CALL_UP_DOCUMENT_ID: z.string().min(1).optional(),

    /**
     * Shared secret the webhook must present, as `?token=` on the callback URL.
     *
     * ⚠️ This authenticates the PING, not the payload. The webhook body is never
     * trusted — see `po-ingest.adapter.ts`. Its only job is to stop an anonymous
     * caller making us fetch arbitrary extraction ids.
     */
    EXTRACTOR_WEBHOOK_SECRET: z.string().min(16).optional(),

    /**
     * I1 · M7.8 — Xero.
     *
     * `off` is a working state, not a broken one: invoices behave exactly as
     * they do today and every sync badge stays on "Not sent to Xero". Turning
     * the integration on is this variable plus credentials — never a code
     * change (§8).
     *
     * ⚠️ Unlike every other integration here, credentials alone are not enough.
     * Xero has no static key for a company's books: the organisation owner must
     * authorise PlastaGo from a browser, once, and only then does a connection
     * exist. See `domains/xero`.
     */
    XERO_PROVIDER: z.enum(['off', 'xero']).default('off'),

    XERO_CLIENT_ID: z.string().min(1).optional(),
    /** ⚠️ Never reaches a browser. Used only on the server-to-server token calls. */
    XERO_CLIENT_SECRET: z.string().min(1).optional(),

    /**
     * Where Xero sends the organisation owner back to after they approve.
     *
     * ── Why this is configuration and not derived ─────────────────────────
     * Xero compares it against the app's registered redirect URIs as an exact
     * string — scheme, port and trailing slash included — and rejects the whole
     * sign-in with `invalid_grant` if it differs by a character. Deriving it
     * from `AUTH_BASE_URL` is right in every environment we control, but the
     * override exists for the one that sits behind a proxy whose public origin
     * is not the origin the process knows about.
     */
    XERO_REDIRECT_URI: z.string().url().optional(),

    /**
     * Encrypts the Xero refresh token at rest (AES-256-GCM). 32 bytes, hex.
     *
     * ── Why this one credential is encrypted when others are not ──────────
     * Everything else in this file is a credential we hold for ourselves. The
     * Xero refresh token is a credential a CUSTOMER granted us over their own
     * accounting records, it is long-lived, and it lives in a database rather
     * than in an environment variable — a different exposure with a different
     * blast radius. A leaked Mongo backup should not be a leaked ledger.
     *
     * ⚠️ Rotating this does not corrupt anything, but it does make the stored
     * connection undecryptable: the page reports "reconnect required" and
     * Matthew reconnects once.
     */
    XERO_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'Must be 64 hex characters — generate with: openssl rand -hex 32')
      .optional(),

    /**
     * The status a pushed invoice takes ON in Xero.
     *
     * ⚠️ Defaults to `DRAFT` deliberately, and the default is the safe one.
     * `AUTHORISED` puts the invoice straight into the ledger with no human
     * between PlastaGo and the books — so an invoice this platform got wrong is
     * already a real accounting document by the time anyone notices. DRAFT
     * lands it in Xero's own draft list where the accountant approves it.
     *
     * This is the client's accountant's decision, not a technical one.
     */
    XERO_INVOICE_STATUS: z.enum(['DRAFT', 'AUTHORISED']).default('DRAFT'),

    /**
     * I3 — Google Maps on the SERVER side: geocoding and route ordering.
     *
     * ── Why this is separate from the browser key ─────────────────────────
     * `VITE_GOOGLE_MAPS_EMBED_KEY` lives in the frontend bundles and is public
     * by definition — it is compiled into an app that runs on a driver's phone.
     * This one can spend money, so it never reaches a browser. Two keys costs
     * nothing and means the readable credential cannot be billed against.
     *
     * `off` is the safe default and the behaviour this platform shipped with:
     * a job takes the pin of its chosen suburb, and `optimiseRun` groups stops
     * by suburb without claiming to have computed a route. Turning it on is
     * this variable plus the key — never a code change (§8).
     */
    MAPS_PROVIDER: z.enum(['off', 'google']).default('off'),

    /**
     * ⚠️ Named for the value the client sent us, not for what it does — it is a
     * Geocoding and Routes key, nothing to do with the Embed API. Renaming it
     * means the client re-sending a credential, which is the more expensive
     * mistake of the two.
     *
     * ⚠️ Needs Geocoding API *and* Routes API enabled on the Google project.
     * Route Optimization API is deliberately NOT used: it authenticates by
     * service account and IAM only, and rejects an API key outright.
     */
    GOOGLE_MAPS_EMBED_API_SERVER: z.string().min(1).optional(),

    /**
     * How far a geocoded pin may sit from the suburb it was booked into, in km.
     *
     * ── Why a sanity check at all ─────────────────────────────────────────
     * Google answers "18 Ashworth Bvd" with a street in Victoria as readily as
     * the one in Kellyville, and it does so with no lower confidence. A pin
     * that lands interstate is not a worse pin — it sends a truck to the wrong
     * state — so a result further than this from the picked suburb is DISCARDED
     * and the suburb centroid stands. The suburb is the one part of the address
     * a human definitely chose from a list.
     *
     * 25km comfortably contains any Sydney suburb plus its neighbours; the NSW
     * suburbs PlastaGo services are nothing like that wide.
     */
    GEOCODE_MAX_DRIFT_KM: z.coerce.number().positive().max(200).default(25),
  })
  .superRefine((value, ctx) => {
    const isProd = value.NODE_ENV === 'production';

    if (isProd && value.BETTER_AUTH_SECRET.startsWith('dev-only-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message:
          'The development default cannot be used in production. Generate one: openssl rand -hex 32',
      });
    }

    // Selecting a provider without its credentials would fail at the moment a
    // user tries to sign in — i.e. in front of them. Fail at boot instead.
    if (value.MAIL_PROVIDER === 'graph') {
      for (const key of [
        'MS_GRAPH_TENANT_ID',
        'MS_GRAPH_CLIENT_ID',
        'MS_GRAPH_CLIENT_SECRET',
        'MS_GRAPH_MAIL_SENDER',
      ] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when MAIL_PROVIDER=graph',
          });
        }
      }
    }

    if (value.SMS_PROVIDER === 'clicksend') {
      for (const key of ['CLICKSEND_USERNAME', 'CLICKSEND_API_KEY', 'CLICKSEND_FROM'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when SMS_PROVIDER=clicksend',
          });
        }
      }
    }

    if (value.STORAGE_PROVIDER === 's3') {
      // The region and bucket have no sane default. Credentials deliberately do
      // NOT appear here: on EC2/ECS the instance role supplies them, and
      // demanding a static key would push deployments towards the worse option.
      for (const key of ['S3_REGION', 'S3_BUCKET'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when STORAGE_PROVIDER=s3',
          });
        }
      }

      // Half a key pair is always a mistake, and the failure it causes is an
      // opaque SDK error at the moment a driver uploads a photo.
      const hasId = Boolean(value.S3_ACCESS_KEY_ID);
      const hasSecret = Boolean(value.S3_SECRET_ACCESS_KEY);
      if (hasId !== hasSecret) {
        ctx.addIssue({
          code: 'custom',
          path: [hasId ? 'S3_SECRET_ACCESS_KEY' : 'S3_ACCESS_KEY_ID'],
          message:
            'Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the instance role',
        });
      }
    }

    /*
     * Local disk in production is not durable storage: containers are replaced,
     * and the completion photos that defend a futile charge would go with them.
     */
    if (isProd && value.STORAGE_PROVIDER === 'stub') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_PROVIDER'],
        message: 'Cannot be "stub" in production — photos and dockets would not survive a restart',
      });
    }

    /*
     * Selecting the extractor without its credentials would fail at the moment a
     * purchase order arrives — silently, in a background handler nobody is
     * watching. Fail at boot instead.
     *
     * `EXTRACTOR_DOCUMENT_ID` is absent from this list on purpose: it is produced
     * by `seed-extractor`, which cannot run until the app is already booted with
     * the credentials below.
     */
    if (value.EXTRACTOR_PROVIDER === 'threepm') {
      for (const key of [
        'EXTRACTOR_APP_ID',
        'EXTRACTOR_APP_SECRET',
        'EXTRACTOR_EMBED_TOKEN',
        'EXTRACTOR_USER_EMAIL',
        'EXTRACTOR_WEBHOOK_SECRET',
      ] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when EXTRACTOR_PROVIDER=threepm',
          });
        }
      }
    }

    /*
     * Selecting Xero without its credentials would fail the moment somebody
     * clicks Connect — in front of them, on a page whose only purpose is that
     * button. Fail at boot instead.
     *
     * The redirect URI is absent from this list because it has a sane default
     * (AUTH_BASE_URL + the callback path); the encryption key is NOT, because
     * its absence would mean writing a customers refresh token to the database
     * in clear text, which is a thing to refuse rather than to default.
     */
    if (value.XERO_PROVIDER === 'xero') {
      for (const key of ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_ENCRYPTION_KEY'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when XERO_PROVIDER=xero',
          });
        }
      }
    }

    // A production deployment that cannot send a code cannot let anyone in.
    if (isProd && value.MAIL_PROVIDER === 'stub') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_PROVIDER'],
        message: 'Cannot be "stub" in production — nobody would receive a sign-in code',
      });
    }
    if (isProd && value.SMS_PROVIDER === 'stub') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'Cannot be "stub" in production — drivers sign in by SMS (§9 A2)',
      });
    }

    // Selecting the provider without the key would fail at the moment an office
    // user books a job — i.e. in front of a customer on the phone. Fail at boot.
    if (value.MAPS_PROVIDER === 'google' && !value.GOOGLE_MAPS_EMBED_API_SERVER) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_MAPS_EMBED_API_SERVER'],
        message: 'Required when MAPS_PROVIDER=google',
      });
    }
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Cannot use the logger here — it depends on this module.
  console.error(`\nInvalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * In production a missing database is fatal. In development we log loudly and
 * keep serving, so the frontend team is never blocked by infrastructure.
 */
export const requireDatabase = isProduction;

/**
 * Whether to admit that an identifier is unknown.
 *
 * Production never does, whatever the variable says: the customer portal is
 * internet-facing, and "does this email have an account" is exactly the
 * question an attacker enumerates before a phishing run.
 */
export const revealUnknownIdentifier = !isProduction && env.AUTH_REVEAL_UNKNOWN_IDENTIFIER;

/**
 * Whether to hand the sign-in code back in the response body.
 *
 * Production never does, whatever the variable says. This one is deliberately
 * belt-and-braces: unlike the flag above, a mistake here does not merely leak
 * whether an account exists — it hands out a working credential for it. The
 * `!isProduction` guard means the variable cannot be the only thing standing
 * between a live deployment and an unauthenticated sign-in.
 */
export const revealOtpCode = !isProduction && env.AUTH_REVEAL_OTP_CODE;

/**
 * Where Xero returns the organisation owner after they approve.
 *
 * Derived from `AUTH_BASE_URL` so there is one origin to change per
 * environment, but overridable because Xero matches this string EXACTLY
 * against the app registration and a proxy can make the two differ.
 */
export const xeroRedirectUri = (): string =>
  env.XERO_REDIRECT_URI ?? `${env.AUTH_BASE_URL}/api/v1/xero/callback`;

/**
 * Is this a browser on the developer's own machine?
 *
 * ── Why development does not use the allowlist strictly ───────────────────
 * `CORS_ORIGINS` is not in version control — `.env` is gitignored — so every
 * developer carries their own copy, and the day the surfaces moved to their own
 * ports (§6A.5) every existing copy became wrong without anybody editing it.
 * The symptom is not a clear error: the Vite proxy keeps same-origin calls
 * working, so the console behaves normally while the portal and the driver app
 * cannot sign anyone in, and the reason is in a file nobody has touched.
 *
 * So on a laptop any localhost origin is accepted. It costs nothing there — a
 * page that can already reach `localhost` can reach the API regardless — and it
 * means a teammate pulling this branch does not have to edit `.env` before the
 * app works.
 *
 * ⚠️ Development ONLY. `isProduction` gates every use of this, and a deployed
 * environment still answers exactly the allowlist it was given.
 */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * The origins Better Auth will accept a sign-in from.
 *
 * Better Auth matches `*` as a wildcard (see `auth/trusted-origins`), which is
 * how the development widening above is expressed to it. In production this is
 * the allowlist and nothing else.
 *
 * ⚠️ Keep in step with the CORS callback in `middleware/security.ts`. They are
 * two enforcement points for one policy, and a surface that passes CORS but is
 * not trusted here fails at the sign-in POST rather than at the preflight —
 * which reads as "the code is wrong", not "the config is".
 */
export const trustedOrigins: string[] = isProduction
  ? env.CORS_ORIGINS
  : [...new Set([...env.CORS_ORIGINS, 'http://localhost:*', 'http://127.0.0.1:*'])];

/**
 * The public origin of one surface.
 *
 * ⚠️ Every caller is building a link into a message that CANNOT BE CORRECTED
 * ONCE SENT — an SMS to a supervisor, an invitation email, a redirect back from
 * Xero. That is why an unset surface URL falls back to `PUBLIC_APP_URL` rather
 * than throwing or returning empty: a deployment mid-way through being split
 * should send a link that works and is merely on the old origin, not one that
 * 404s or reads `undefined/portal/jobs`.
 *
 * Pair it with `ROLE_SURFACE` when what you hold is a role rather than a
 * surface — the mapping belongs in one place, and it is already there.
 */
export function publicUrlFor(surface: Surface): string {
  const configured = {
    admin: env.PUBLIC_ADMIN_URL,
    portal: env.PUBLIC_PORTAL_URL,
    driver: env.PUBLIC_DRIVER_URL,
  }[surface];

  return configured ?? env.PUBLIC_APP_URL;
}

export type Env = typeof env;
