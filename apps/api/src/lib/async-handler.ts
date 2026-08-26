import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Central async wrapper (§6A.7).
 *
 * Express 5 already forwards rejected promises from async handlers, so this is
 * belt-and-braces rather than strictly required — but it is kept because it
 * makes the intent explicit at every route and it guarantees the behaviour if a
 * handler is ever mounted somewhere Express does not await it.
 *
 * Rule: every controller is wrapped. No exceptions, so nobody has to remember
 * which ones are safe.
 */
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req as Req, res, next)).catch(next);
  };
}
