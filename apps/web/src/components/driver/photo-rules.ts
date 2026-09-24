import { photoPurpose, type DriverPhoto, type RequiredPhoto } from '@plastago/shared';

/**
 * The photos of the pickup itself — the checklist shots and their extras —
 * without either exception report's evidence.
 *
 * The Photos screen showed every photo on the job, so a locked gate shot for
 * could-not-collect sat under "anything else" beside the pile-before shot.
 * Each report keeps its own photos now; see `photoPurpose`.
 */
export function jobPhotos(photos: readonly DriverPhoto[]): DriverPhoto[] {
  return photos.filter((photo) => photoPurpose(photo) === 'job');
}

/** The photos taken as evidence for one exception report, and nothing else. */
export function evidencePhotos(
  photos: readonly DriverPhoto[],
  report: 'futile' | 'contamination',
): DriverPhoto[] {
  return photos.filter((photo) => photoPurpose(photo) === report);
}

/**
 * Which required photo slots are still empty (M4.5).
 *
 * ── Why this is its own module ────────────────────────────────────────────
 * Two consumers need the same answer — the photo grid draws the checklist from
 * it and the job screen blocks completion on it — and fast refresh only works in
 * a module that exports components and nothing else. A helper living beside the
 * grid would have quietly disabled HMR for every screen that imports it.
 *
 * The conditional slots are excluded on purpose. "Cars still on site" only
 * applies when the site could not be closed, and requiring it always would train
 * drivers to take a meaningless photo to get past the guard — which is worse than
 * not asking, because it devalues the whole evidence set.
 */
export function missingRequiredPhotos(
  photos: readonly DriverPhoto[],
  required: readonly RequiredPhoto[],
): RequiredPhoto[] {
  return required.filter(
    (slot) => slot.required && !photos.some((photo) => photo.slot === slot.key),
  );
}
