import type { Request, Response } from 'express';
import { AppError } from '../../lib/app-error.js';
import { extractorService, type Caller } from './extractor.service.js';

/** Controller layer — HTTP in, HTTP out. No business rules, no Mongoose. */

function callerFrom(req: Request): Caller {
  if (!req.auth) throw AppError.unauthenticated('Sign in to continue');
  return { userId: req.auth.userId, name: req.auth.name };
}

export const extractorController = {
  /**
   * Mints the iframe's credential.
   *
   * ── Why POST for something that reads like a GET ──────────────────────────
   * Because it is not a read: it creates a session at a third party, provisions
   * the caller into a tenant on first use, and may onboard. A GET that does all
   * that is one a browser or proxy is entitled to repeat and cache.
   *
   * ── Why the body is empty ─────────────────────────────────────────────────
   * The caller supplies nothing. Identity comes from the session cookie, and
   * accepting a `userEmail` — even one the server checked — would mean this
   * endpoint's shape suggests a session can be minted for somebody else.
   */
  session: async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await extractorService.sessionFor(callerFrom(req)));
  },

  /**
   * Drops the cached session so the next load mints a fresh one.
   *
   * The escape hatch for an "Invalid session" inside the iframe, which the
   * browser cannot fix by reloading — the cache would hand back the same dead
   * id until it expired.
   */
  forget: async (req: Request, res: Response): Promise<void> => {
    await extractorService.forget(callerFrom(req));
    res.status(204).send();
  },
};
