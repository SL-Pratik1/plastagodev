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
        /**
         * The caller's display name, for audit trails — a job event's actor, a
         * comment's author, who booked a job.
         *
         * Frozen into those records on write, because they have to survive the
         * person leaving: a job booked in 2026 by someone who is gone by 2027
         * must still say who booked it.
         */
        name: string;
        roles: readonly string[];
        /**
         * The account this caller belongs to — set only for the two customer
         * roles, null for office and admin.
         *
         * ⚠️ This is a scoping input, not a display field. Repositories narrow
         * queries by it, so a wrong value here is a data-leak, not a cosmetic
         * bug. It comes from the re-read session on every request rather than
         * from a token, for the same reason the role does.
         */
        accountId: string | null;
      };
    }
  }
}

export {};
