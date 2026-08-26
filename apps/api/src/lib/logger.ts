import { pino } from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Structured JSON logs are the ONLY observability this build has — error
 * tracking was removed by decision (§6A.8). That makes log quality a
 * requirement, not a nicety:
 *   • always log the requestId so a user report maps to a line
 *   • never log credentials, tokens, or full request bodies
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'plastago-api', env: env.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.otp',
      'req.body.token',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss' },
        },
      }),
});

export type Logger = typeof logger;
