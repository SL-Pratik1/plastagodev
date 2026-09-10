import 'dotenv/config';
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

    /** Comma-separated CORS allowlist. Never `*` in production. */
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173,http://localhost:5174')
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
    SMS_PROVIDER: z.enum(['stub', 'twilio']).default('stub'),

    /** I5/I6 — one Entra app registration serves Mail.Send now and Mail.Read later. */
    MS_GRAPH_TENANT_ID: z.string().min(1).optional(),
    MS_GRAPH_CLIENT_ID: z.string().min(1).optional(),
    MS_GRAPH_CLIENT_SECRET: z.string().min(1).optional(),
    /** The mailbox Graph sends AS, e.g. `noreply@plastago.com.au`. */
    MS_GRAPH_MAIL_SENDER: z.string().email().optional(),

    /** I2 — SMS to drivers and site supervisors. */
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    /** A Twilio number in E.164, or an approved alphanumeric sender id. */
    TWILIO_FROM: z.string().min(1).optional(),

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
     * No trailing slash: every caller appends a path.
     */
    PUBLIC_APP_URL: z
      .string()
      .url()
      .default('http://localhost:5173')
      .transform((value) => value.replace(/\/+$/, '')),

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
     * Shared secret the webhook must present, as `?token=` on the callback URL.
     *
     * ⚠️ This authenticates the PING, not the payload. The webhook body is never
     * trusted — see `po-ingest.adapter.ts`. Its only job is to stop an anonymous
     * caller making us fetch arbitrary extraction ids.
     */
    EXTRACTOR_WEBHOOK_SECRET: z.string().min(16).optional(),
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

    if (value.SMS_PROVIDER === 'twilio') {
      for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when SMS_PROVIDER=twilio',
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

export type Env = typeof env;
