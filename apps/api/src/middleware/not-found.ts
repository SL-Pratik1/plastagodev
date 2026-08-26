import type { RequestHandler } from 'express';
import { AppError } from '../lib/app-error.js';

/**
 * Mounted after every router. Turns an unmatched path into the same ApiError
 * envelope as everything else, rather than Express's HTML default.
 */
export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No route for ${req.method} ${req.path}`));
};
