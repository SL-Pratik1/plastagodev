import { createHash } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import { IdempotencyKeyModel } from './idempotency.model.js';

const log = logger.child({ module: 'idempotency' });

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** A UUID v4, which is what the sync protocol specifies the client generates. */
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fingerprint(body: unknown): string {
  // Stable enough for the purpose: the client replays the SAME serialised body
  // from its outbox, so key order does not drift between attempts.
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

/**
 * Replay protection for driver writes (`docs/offline-sync-protocol.md` §3).
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * First request with a given key: claims the key, runs the handler, captures
 * the response. Any later request with the same key returns that captured
 * response without touching the handler — so a phone that retried because it
 * never saw the first reply gets the original answer rather than a second
 * charge.
 *
 * ── Why it is opt-in per request, not enforced ────────────────────────────
 * A request with no header runs normally. The header is what the driver app
 * sends; the office console and the customer portal do not queue writes and
 * have nothing to replay. Refusing unkeyed writes would break both for no
 * safety gain — and the driver app was shipped asking for this behaviour before
 * the server had it, so it must stay tolerant of clients that do not send one.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────
 * Mount AFTER authentication: keys are scoped per user, and `req.auth` has to
 * exist to scope them.
 */
export const idempotency: RequestHandler = (req, res, next) => {
  const header = req.get(IDEMPOTENCY_HEADER);

  // Reads are already idempotent, and a GET carries nothing to replay.
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }

  if (!header) {
    next();
    return;
  }

  if (!KEY_PATTERN.test(header)) {
    next(
      AppError.validation('That idempotency key is not usable', [
        { path: IDEMPOTENCY_HEADER, message: 'Must be a UUID v4' },
      ]),
    );
    return;
  }

  const userId = req.auth?.userId;
  if (!userId) {
    // Unauthenticated writes cannot be scoped to anyone, so there is nothing
    // safe to key on. Let the route's own auth gate answer.
    next();
    return;
  }

  void (async () => {
    const requestHash = fingerprint(req.body);
    const claim = {
      key: header,
      userId,
      method: req.method,
      path: req.originalUrl,
      requestHash,
      status: 'in-flight' as const,
      createdAt: new Date(),
    };

    try {
      await IdempotencyKeyModel.create(claim);
    } catch (error) {
      // Duplicate key — somebody got here first. That is the whole point.
      if (isDuplicate(error)) {
        await replay(header, userId, requestHash, res, next);
        return;
      }
      next(error);
      return;
    }

    capture(header, userId, res);
    next();
  })();
};

/** Serve — or refuse — a request whose key has been seen before. */
async function replay(
  key: string,
  userId: string,
  requestHash: string,
  res: Response,
  next: (error?: unknown) => void,
): Promise<void> {
  const existing = await IdempotencyKeyModel.findOne({ userId, key }).lean<{
    requestHash: string;
    status: 'in-flight' | 'complete';
    responseStatus: number | null;
    responseBody: unknown;
  }>();

  if (!existing) {
    // The row went between the failed insert and this read — a TTL sweep on a
    // very old key. Treat it as new rather than inventing an error.
    next();
    return;
  }

  if (existing.requestHash !== requestHash) {
    log.warn({ key, userId }, 'idempotency key reused with a different body');
    next(
      AppError.conflict(
        'That idempotency key was already used for a different request. Generate a new key per operation.',
      ),
    );
    return;
  }

  if (existing.status === 'in-flight') {
    // The first attempt is still running. Answering now would either duplicate
    // the work or report a result that has not happened yet.
    log.info({ key, userId }, 'replay arrived while the original is still running');
    next(AppError.conflict('That request is still being processed — retry shortly'));
    return;
  }

  log.info({ key, userId, status: existing.responseStatus }, 'replayed a completed request');

  const status = existing.responseStatus ?? 204;
  res.setHeader('idempotent-replay', 'true');

  if (existing.responseBody === null || existing.responseBody === undefined) {
    res.status(status).send();
    return;
  }
  res.status(status).json(existing.responseBody);
}

/**
 * Record what the handler answered, so the next attempt can be given the same.
 *
 * Wraps `json` and `send` rather than listening for `finish`: by the time the
 * response has flushed, the body is gone.
 */
function capture(key: string, userId: string, res: Response): void {
  const { json, send } = res;
  let saved = false;

  const persist = (body: unknown): void => {
    if (saved) return;
    saved = true;

    // A failure is not a completed operation: the client SHOULD retry it, and
    // pinning a 500 to this key would make the failure permanent.
    if (res.statusCode >= 400) {
      void IdempotencyKeyModel.deleteOne({ userId, key }).catch((error: unknown) => {
        log.error({ err: error, key }, 'could not release an idempotency key after a failure');
      });
      return;
    }

    void IdempotencyKeyModel.updateOne(
      { userId, key },
      {
        $set: {
          status: 'complete',
          responseStatus: res.statusCode,
          responseBody: body ?? null,
          completedAt: new Date(),
        },
      },
    ).catch((error: unknown) => {
      log.error({ err: error, key }, 'could not record an idempotent response');
    });
  };

  res.json = function patchedJson(this: Response, body: unknown) {
    persist(body);
    return json.call(this, body);
  };

  res.send = function patchedSend(this: Response, body?: unknown) {
    // A 204 sends nothing; that is a valid captured response, not a missing one.
    persist(typeof body === 'undefined' ? null : body);
    return send.call(this, body);
  };
}

function isDuplicate(error: unknown): boolean {
  return (
    error instanceof mongoose.mongo.MongoServerError && error.code === 11000
  );
}
