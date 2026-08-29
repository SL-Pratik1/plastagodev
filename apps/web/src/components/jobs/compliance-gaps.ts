import type { Job } from '@plastago/shared';

/**
 * How many things in a job's safety record someone has to do something about.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * Fast refresh only works in a module that exports components and nothing else,
 * so keeping this beside `ComplianceTab` would disable HMR for the tab it
 * belongs to. Same reason the services context is split from its provider.
 *
 * ── Why it is shared rather than computed twice ───────────────────────────
 * The job screen's tab badge and the panel behind it must agree. A badge
 * counting one thing while the panel shows another is worse than no badge: it
 * teaches people that the number is decorative.
 *
 * ⚠️ Takes the whole job, not just `job.compliance`, because the first rule
 * needs `arrivedAt`. A missing assessment is only a gap once the driver
 * actually reached the site — a booked job with no assessment is not behind,
 * it simply has not started, and flagging it is the false alarm that stops
 * anyone reading the tab at all.
 */
export function countComplianceGaps(job: Job): number {
  const { compliance } = job;
  let gaps = 0;

  // Required, the driver got there, and nothing was submitted.
  if (compliance.riskAssessmentRequired && compliance.riskAssessment === null && job.arrivedAt) {
    gaps += 1;
  }
  // The driver judged the site unsafe and stopped.
  if (compliance.riskAssessment?.safeToProceed === false) gaps += 1;
  // Step 5 — the handoff to the builder's own portal never landed. Invisible to
  // the driver, who drove away hours ago, so the office is the only one who can
  // notice.
  if (compliance.riskAssessment?.uploadState === 'failed') gaps += 1;
  // A truck fault the driver flagged on the morning check.
  if ((compliance.preStart?.failedItems.length ?? 0) > 0) gaps += 1;

  return gaps;
}
