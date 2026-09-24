import type { JobPhoto } from '@plastago/shared';
import { getStorage } from '../../integrations/storage.js';
import { logger } from '../../lib/logger.js';

const log = logger.child({ module: 'job-photo-view' });

/**
 * The stored photo rows, as every office screen needs to see them.
 *
 * ── Why this is shared rather than mapped per caller ──────────────────────
 * Three places turn `jobphotos` rows into `JobPhoto`: the job detail, the
 * approvals queue and the futile review. All three used to drop the storage key
 * on the floor and hand the UI a caption with no picture, and they did it in
 * three separate copies of the same object literal — so the bug had to be found
 * three times and fixed three times. One mapper means the signing rule lives in
 * one place and a fourth screen cannot reintroduce the same hole.
 *
 * ── Why an unconfirmed photo gets no URL ──────────────────────────────────
 * `storageKey` is assigned while the upload URL is being signed, before a single
 * byte exists, so a key alone proves only that a photo was INTENDED.
 * `uploadedAt` is the phone confirming the bytes landed. Signing a URL on the
 * strength of the key would hand the office a link to an object that is not
 * there, which renders as a broken image — and on an evidence grid a broken
 * image reads as "the photo is lost" rather than "it never finished sending".
 *
 * ── Why a signing failure is not an error ─────────────────────────────────
 * Signing is a local HMAC, so it realistically only throws when storage is
 * misconfigured. An approver should still get the charge, the driver's note, the
 * time and the GPS fix in that case — a missing thumbnail is a degraded screen,
 * an exception is no screen at all. The row degrades to `url: null`, which the
 * grid already knows how to render.
 */
export interface JobPhotoRow {
  _id: { toHexString: () => string };
  caption: string;
  takenAt: Date;
  takenBy?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  storageKey?: string | null;
  uploadedAt?: Date | null;
}

export async function toJobPhotoViews(rows: readonly JobPhotoRow[]): Promise<JobPhoto[]> {
  const storage = getStorage();

  return Promise.all(
    rows.map(async (photo): Promise<JobPhoto> => {
      const uploaded = (photo.uploadedAt ?? null) !== null;
      const key = photo.storageKey ?? null;

      let url: string | null = null;
      if (uploaded && key !== null) {
        url = await storage.presignDownload(key).catch((error: unknown) => {
          log.warn({ err: error, photoId: photo._id.toHexString() }, 'could not sign a photo URL');
          return null;
        });
      }

      return {
        id: photo._id.toHexString(),
        caption: photo.caption,
        takenAt: photo.takenAt.toISOString(),
        takenBy: photo.takenBy ?? '',
        latitude: photo.latitude ?? null,
        longitude: photo.longitude ?? null,
        url,
      };
    }),
  );
}
