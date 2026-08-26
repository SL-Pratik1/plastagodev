import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

const HEADER = 'x-request-id';

/**
 * Every response carries a request id, and every log line for that request
 * carries the same one. With no error-tracking vendor (§6A.8), this is how a
 * support message ("it failed at about 10:15") becomes a specific log line.
 */
export function resolveRequestId(req: Request): string {
  const incoming = req.headers[HEADER];
  if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200) {
    return incoming;
  }
  return randomUUID();
}

export const REQUEST_ID_HEADER = HEADER;
