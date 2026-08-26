/**
 * Every queue name in one place, so a typo is a compile error rather than a job
 * that is enqueued and never consumed.
 *
 * `system` is the only queue the scaffold needs. The business queues below are
 * declared as comments rather than code — add them when their domain lands, not
 * before, so `/queues` never lists a worker that does not exist.
 *
 *   'notifications'   M8  — SMS + email fan-out via Twilio / M365
 *   'documents'       M7  — invoice + certificate PDF rendering (Playwright)
 *   'po-ingestion'    M2.12 — M365 mailbox poll → Mistral OCR → match
 *   'xero-sync'       M7.8 — invoice push, payment pull
 *   'reporting'       M9  — nightly $merge rollups (§6A.3 #8)
 */
export const QUEUE_NAMES = {
  system: 'system',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Payloads, keyed by job name. Workers switch on this discriminant. */
export interface SystemJobs {
  heartbeat: { enqueuedAt: string };
}
