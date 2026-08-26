import { createDocument, type ZodOpenApiObject } from 'zod-openapi';
import { API_VERSION } from '../constants.js';
import { LivenessSchema, ReadinessSchema } from '../schemas/health.js';
import { jsonResponse } from './helpers.js';

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
    tags: [{ name: 'Health', description: 'Liveness and readiness probes' }],
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
    },
  };

  return createDocument(spec);
}
