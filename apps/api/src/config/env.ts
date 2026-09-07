import 'dotenv/config';
import * as z from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env`
 * again. A missing or malformed variable fails the process immediately with a
 * readable message rather than surfacing as a null-pointer three screens deep.
 */
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

    /** Codes any one identifier may request per hour, however many IPs are used. */
    OTP_MAX_SENDS_PER_HOUR: z.coerce.number().int().positive().default(6),

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

export type Env = typeof env;
