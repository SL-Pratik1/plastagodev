import 'dotenv/config';
import * as z from 'zod';

/**
 * Environment is validated once, at boot, and never read from `process.env`
 * again. A missing or malformed variable fails the process immediately with a
 * readable message rather than surfacing as a null-pointer three screens deep.
 */
const EnvSchema = z.object({
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

export type Env = typeof env;
