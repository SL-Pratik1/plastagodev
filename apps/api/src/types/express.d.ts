/**
 * Express request augmentations.
 *
 * Keep this list short and deliberate. Anything bolted onto `req` is global
 * mutable state that every handler can read, so it earns its place only when
 * genuinely cross-cutting: correlation, validated input, and the caller identity.
 */
declare global {
  namespace Express {
    interface Request {
      /** Correlation id echoed in the response header and every log line. */
      requestId: string;

      /**
       * Output of `validate(...)`. Read it through `ValidatedRequest<S>` rather
       * than casting at the call site.
       */
      validated?: unknown;

      /**
       * Populated by the auth middleware once OTP + JWT land (M1.5).
       * Declared now so route handlers can be written against a stable shape.
       */
      auth?: {
        userId: string;
        roles: readonly string[];
      };
    }
  }
}

export {};
