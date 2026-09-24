import {
  ContaminationExtentSchema,
  ContaminationTypeSchema,
  type ContaminationExtent,
  type ContaminationType,
} from '@plastago/shared';

/**
 * The note a contamination charge carries — `type · extent`, then ` — ` and the
 * driver's words when they typed any.
 *
 * ── Why the writer and the reader share a file ────────────────────────────
 * A report made before the report record existed survives only as that charge,
 * and `parseContaminationNote` is how the job still says what was reported on
 * it. The two halves of one format belong side by side: the day somebody
 * rewords the note, the reader must change with it.
 */
export function describeContamination(
  type: ContaminationType | null,
  extent: ContaminationExtent | null,
  note: string | null,
): string {
  const head = type !== null && extent !== null ? `${type} · ${extent}` : 'contamination';
  return note ? `${head} — ${note}` : head;
}

/**
 * The type and extent back out of a contamination charge's note.
 *
 * Anything that does not parse — a charge the office keyed by hand, say —
 * yields nulls rather than a guess, and keeps its text whole as the note.
 */
export function parseContaminationNote(note: string | null): {
  type: ContaminationType | null;
  extent: ContaminationExtent | null;
  note: string | null;
} {
  if (!note) return { type: null, extent: null, note: null };

  const [head = '', ...rest] = note.split(' — ');
  const [rawType, rawExtent] = head.split(' · ');
  const type = ContaminationTypeSchema.safeParse(rawType?.trim());
  const extent = ContaminationExtentSchema.safeParse(rawExtent?.trim());

  if (!type.success || !extent.success) return { type: null, extent: null, note };

  return { type: type.data, extent: extent.data, note: rest.join(' — ').trim() || null };
}
