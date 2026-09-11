import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/app-error.js';
import { asyncHandler } from '../../lib/async-handler.js';
import {
  MAX_UPLOAD_BYTES,
  contentTypeForKey,
  getStorage,
  stubPathFor,
  verifyStubToken,
} from '../../integrations/storage.js';

/**
 * The stub storage provider's own transport (§6A.10 #9).
 *
 * ── Why this route exists at all ──────────────────────────────────────────
 * With `STORAGE_PROVIDER=s3` the phone PUTs straight to AWS and nothing here is
 * ever reached. The stub has to stand in for that so the client code path is
 * IDENTICAL in development: ask for a URL, PUT the bytes to it, reference the
 * key. If the phone had to behave differently on a laptop, the thing being
 * tested would not be the thing being shipped.
 *
 * ── Why it is not behind `requireAuth` ────────────────────────────────────
 * Because S3 is not either. The presigned URL IS the credential: it is signed
 * over the key and an expiry, it is short-lived, and it is issued only to a
 * driver already authorised for that job. Requiring a session on top would model
 * something the real provider does not do, and would hide a signing bug behind
 * a cookie.
 */
export const storageRouter = Router();

/** Refuses anything the signature does not cover. */
function requireValidToken(req: Request): string {
  if (env.STORAGE_PROVIDER !== 'stub') {
    // With a real provider these URLs are never issued, so a request for one is
    // either a stale client or somebody probing.
    throw AppError.notFound('No route for this request');
  }

  // A wildcard param can arrive as an array too. Same reasoning as the query
  // values below: reject rather than coerce.
  const rawKey = req.params.key;
  const key = typeof rawKey === 'string' ? decodeURIComponent(rawKey) : '';

  /*
   * Express parses `?token[]=a&token[]=b` into an array and `?token[x]=y` into
   * an object. Stringifying either gives nonsense that would then be compared
   * against a real signature — so anything that is not a plain string is
   * rejected outright rather than coerced.
   */
  const expires = typeof req.query.expires === 'string' ? Number(req.query.expires) : Number.NaN;
  const token = typeof req.query.token === 'string' ? req.query.token : '';

  if (!verifyStubToken(key, expires, token)) {
    throw AppError.forbidden('That upload link is not valid, or has expired');
  }

  return key;
}

/** The PUT the phone makes with the bytes. */
storageRouter.put(
  '/storage/:key',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const key = requireValidToken(req);

    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      throw AppError.validation('That file is too large', [
        { path: 'content-length', message: 'Uploads are capped at 20 MB' },
      ]);
    }

    const path = stubPathFor(key);
    await mkdir(dirname(path), { recursive: true });

    /*
     * Streamed rather than buffered, and capped as it goes. A declared
     * `Content-Length` is a claim, not a guarantee — S3 enforces the signed
     * length, so the stub enforces it too, or it would accept uploads the real
     * provider would reject.
     */
    let written = 0;
    req.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > MAX_UPLOAD_BYTES) req.destroy(new Error('Upload exceeded the size limit'));
    });

    await pipeline(req, createWriteStream(path));

    res.status(200).json({ key, bytes: written });
  }),
);

/** The GET that reads one back. */
storageRouter.get(
  '/storage/:key',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const key = requireValidToken(req);

    if (!(await getStorage().exists(key))) throw AppError.notFound('No such object');

    /*
     * The type declared when the key was built, and nothing else. Sending it
     * matters: the PO review screen displays the original PDF beside the
     * extracted fields, and with `nosniff` and no `Content-Type` a browser
     * downloads the file rather than rendering it — so the stub would behave
     * differently from S3, which is the one thing the stub exists to avoid.
     *
     * ⚠️ Still `nosniff`, and still only the six types `buildKey` can encode.
     * These are user-supplied bytes; an unknown extension is served with no
     * type at all rather than a guess.
     */
    const contentType = contentTypeForKey(key);
    if (contentType) res.setHeader('Content-Type', contentType);

    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    await pipeline(await getStorage().get(key), res);
  }),
);
