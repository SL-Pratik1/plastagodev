import { API_PREFIX, buildOpenApiDocument } from '@plastago/shared';
import express, { type Express } from 'express';
import { sortdController } from './domains/sortd/sortd.controller.js';
import { asyncHandler } from './lib/async-handler.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFound } from './middleware/not-found.js';
import { requestId, requestLogger } from './middleware/request-context.js';
import { applySecurity } from './middleware/security.js';
import { mountRoutes } from './routes.js';

/**
 * Assembles the Express app. No listening, no database connection — so tests can
 * build an app and drive it with supertest without any I/O.
 *
 * ⚠️ Middleware ORDER is load-bearing. Do not reorder without reading this:
 *   1. requestId      — everything downstream logs it
 *   2. requestLogger  — must see the id, and must see the final status code
 *   3. security       — reject bad origins and floods before parsing a body
 *   4. body parsers   — with a size cap; photos go direct to S3 (§6A.10 #9)
 *                       (the Sortd webhook is registered just before them, raw)
 *   5. routes
 *   6. notFound       — after all routers
 *   7. errorHandler   — last, always
 */
export function createServer(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestId);
  app.use(requestLogger);

  applySecurity(app);

  /*
   * The Sortd webhook — the one route that must see the RAW body.
   *
   * Sortd signs `${timestamp}.${rawBody}`, and `express.json()` re-serialises,
   * which changes the bytes and fails every signature. So it is registered
   * ahead of the parsers, and `type: () => true` keeps the body a Buffer
   * whatever content type arrives. It also sits outside the `/api/v1` router's
   * session gates, because its authentication IS the signature — see
   * `lib/sortd-webhook.ts`, which refuses everything while a surface's secret
   * is unset.
   */
  app.post(
    `${API_PREFIX}/webhooks/sortd/:surface`,
    express.raw({ type: () => true, limit: '1mb' }),
    asyncHandler(sortdController.webhook),
  );

  // 1 MB is generous for JSON. Photo and document uploads must NEVER stream
  // through the API — they use presigned direct-to-S3 uploads (§6A.10 #9).
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // The generated contract, served for convenience so the frontend and the
  // Flutter codegen can both point at a running instance during development.
  app.get('/openapi.json', (_req, res) => {
    res.json(buildOpenApiDocument());
  });

  mountRoutes(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
