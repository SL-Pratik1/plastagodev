import { createDocument, type ZodOpenApiObject } from 'zod-openapi';
import * as z from 'zod';
import { API_PREFIX, API_VERSION } from '../constants.js';
import { LivenessSchema, ReadinessSchema } from '../schemas/health.js';
import {
  OtpChallengeSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  SessionSchema,
} from '../schemas/identity.js';
import { ObjectIdSchema } from '../schemas/primitives.js';
import { errorResponses, jsonResponse } from './helpers.js';

/** Shorthand for a required JSON request body, mirroring `jsonResponse`. */
function jsonBody(schema: z.ZodType) {
  return { content: { 'application/json': { schema } }, required: true };
}

/**
 * The resend body.
 *
 * ⚠️ Declared here rather than in `schemas/identity.ts` only because the
 * contract was frozen before a resend shape was needed — the web app's
 * `resendCode(challengeId)` takes a bare string, so none was ever written. The
 * VALUE is contract-governed (`ObjectIdSchema`); only this one-key envelope is
 * local. `apps/api/src/domains/auth/auth.schemas.ts` carries the same
 * declaration for validation; when the contract next opens, both move into
 * `schemas/identity.ts` as `OtpResendSchema` and this disappears.
 */
const OtpResendSchema = z
  .object({ challengeId: ObjectIdSchema })
  .meta({ id: 'OtpResend' });

/**
 * The published API contract (§6A.9).
 *
 * Declared HERE, in `@plastago/shared`, rather than inside the Express app — so
 * the spec is an artefact of the contract, not of one server implementation.
 * `apps/api` only writes it to disk; CI publishes it; the Flutter repo pins a
 * version of it and codegens its Dart client from it.
 *
 * Adding an endpoint:
 *   1. Define request/response schemas under `src/schemas/<domain>.ts`.
 *   2. Add the path below.
 *   3. `npm run openapi` — the spec regenerates.
 *   4. After the day-3 freeze, bump API_VERSION on any breaking change.
 */
export function buildOpenApiDocument(): ReturnType<typeof createDocument> {
  const spec: ZodOpenApiObject = {
    openapi: '3.1.0',
    info: {
      title: 'PlastaGo API',
      version: API_VERSION,
      description:
        'Contract shared by the admin console, customer portal, driver PWA and the Flutter ' +
        'driver app. Generated from Zod schemas — do not hand-edit.',
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local development' },
      { url: 'https://api.plastago.com.au', description: 'Production (placeholder)' },
    ],
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      {
        name: 'Authentication',
        description:
          'Email and SMS one-time codes (§9 A1/A2). No passwords exist in this product. ' +
          'Sign-in is a two-step challenge: request a code, then verify it. The identifier ' +
          'is held server-side against the returned challengeId and is never sent again.',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Short-lived access token issued after OTP verification.',
        },
      },
    },
    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          operationId: 'getLiveness',
          summary: 'Liveness probe',
          description: 'Cheap, dependency-free. Used by the platform to decide on a restart.',
          responses: {
            '200': jsonResponse('Process is alive', LivenessSchema),
          },
        },
      },
      '/readyz': {
        get: {
          tags: ['Health'],
          operationId: 'getReadiness',
          summary: 'Readiness probe',
          description: 'Checks Mongo and Redis. Returns 503 while any required dependency is down.',
          responses: {
            '200': jsonResponse('Ready to serve traffic', ReadinessSchema),
            '503': jsonResponse('One or more dependencies unavailable', ReadinessSchema),
          },
        },
      },

      // ── Authentication (§9, M1.5) ───────────────────────────────────────────

      [`${API_PREFIX}/auth/otp/request`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'requestOtp',
          summary: 'Send a one-time sign-in code',
          description:
            'Accepts an email address OR an Australian mobile in one field, and routes to the ' +
            'matching channel. The response never reveals whether the identifier exists: an ' +
            'unrecognised one receives an identically shaped challenge and no message is sent. ' +
            '`sentTo` is masked.',
          requestBody: jsonBody(OtpRequestSchema),
          responses: {
            '201': jsonResponse('A code has been issued', OtpChallengeSchema),
            ...errorResponses('400', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/otp/resend`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'resendOtp',
          summary: 'Re-send the code for an existing challenge',
          description:
            'Refuses until `resendAvailableAt` has passed, and refills the attempt counter. ' +
            'Subject to the same per-identifier ceiling as the initial send.',
          requestBody: jsonBody(OtpResendSchema),
          responses: {
            '201': jsonResponse('A new code has been issued', OtpChallengeSchema),
            ...errorResponses('400', '404', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/otp/verify`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'verifyOtp',
          summary: 'Verify a code and open a session',
          description:
            'On success sets the session cookie and returns the session. On failure the exact ' +
            'reason travels as a field issue at path `authReason` — one of CODE_INCORRECT, ' +
            'CODE_EXPIRED, CODE_ATTEMPTS_EXCEEDED or CHALLENGE_NOT_FOUND — because the closed ' +
            '`ErrorCode` union cannot express them and the sign-in screen needs different copy ' +
            'for each. `CODE_INCORRECT` also carries `attemptsRemaining`.',
          requestBody: jsonBody(OtpVerifySchema),
          responses: {
            '200': jsonResponse('Signed in', SessionSchema),
            ...errorResponses('400', '401', '403', '404', '429'),
          },
        },
      },

      [`${API_PREFIX}/auth/session`]: {
        get: {
          tags: ['Authentication'],
          operationId: 'getCurrentSession',
          summary: 'The current session, or null',
          description:
            'Answers 200 with `null` when nobody is signed in — not 401. Every surface calls ' +
            'this on load, and "no session yet" is the most ordinary state the app has, not an ' +
            'error. The user record is re-read on each call, so a suspended account loses ' +
            'access on its next request rather than at its next sign-in.',
          security: [{ bearerAuth: [] }, {}],
          responses: {
            '200': jsonResponse('The signed-in session, or null', SessionSchema.nullable()),
          },
        },
      },

      [`${API_PREFIX}/auth/sign-out`]: {
        post: {
          tags: ['Authentication'],
          operationId: 'signOut',
          summary: 'End the current session',
          description:
            'Idempotent: succeeds with 204 whether or not a session existed, because the ' +
            'caller has already got what they asked for either way.',
          security: [{ bearerAuth: [] }, {}],
          responses: {
            '204': { description: 'Session ended and the cookie cleared' },
          },
        },
      },
    },
  };

  return createDocument(spec);
}
