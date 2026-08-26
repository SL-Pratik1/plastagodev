/**
 * OCR confidence bands (M2.12).
 *
 * ── Why three bands and not a raw percentage ──────────────────────────────
 * "0.63" is a fact about the model; "check this field" is a fact about the
 * reader's next thirty seconds. Both get shown — the percentage because M2.12
 * requires confidence to be *logged and measured* from day one, and the band
 * because nobody calibrates their own threshold from a decimal at 4:50pm.
 *
 * The thresholds are the ones the pipeline itself uses, so a field the UI paints
 * red is the same field the auto-attach gate would have refused. If those two
 * ever disagree, the UI is lying about why the item is in the queue.
 *
 * ── Why this is a `.ts` file separate from the components ─────────────────
 * Fast refresh only works in a module that exports components and nothing else.
 * Constants and pure helpers live here so editing a threshold does not blow away
 * component state across the app.
 */
export const CONFIDENCE_HIGH = 0.85;
export const CONFIDENCE_LOW = 0.6;

export type ConfidenceBand = 'high' | 'medium' | 'low';

export function bandOf(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_HIGH) return 'high';
  if (confidence >= CONFIDENCE_LOW) return 'medium';
  return 'low';
}

export const BAND_LABEL: Record<ConfidenceBand, string> = {
  high: 'High confidence',
  medium: 'Check this',
  low: 'Low confidence',
};

export function percent(confidence: number): string {
  return `${String(Math.round(confidence * 100))}%`;
}
