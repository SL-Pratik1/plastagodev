import { isServiceError, StorageUploadError } from '@/services/service-error';

/**
 * What to tell a driver whose photo did not upload.
 *
 * ⚠️ Every failure used to read "Photos need signal. Try again in range." — a
 * session that had ended, a job taken off the run, a file storage refused. Matt
 * had signal, so he went looking for a location setting (21 Oct). Each cause
 * now says what it is. Location is never one of them: a photo uploads with or
 * without a position.
 */
export function photoUploadFailure(error: unknown): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'This phone has no signal. Photos send straight away, so take it again once you have signal.';
  }

  if (error instanceof StorageUploadError) {
    return `Photo storage did not accept it${error.status === null ? '' : ` (error ${String(error.status)})`}. This is not your signal or location — try again, and ring the office if it keeps happening.`;
  }

  if (isServiceError(error)) {
    switch (error.code) {
      case 'OFFLINE':
      case 'TIMEOUT':
        return 'PlastaGo could not be reached. Check your signal and try again.';
      case 'UNAUTHENTICATED':
        return 'You have been signed out. Sign in again, then take the photo again.';
      case 'NOT_FOUND':
        return 'This job is no longer on your run. Ring the office.';
      case 'RATE_LIMITED':
        return 'Too many photos at once. Wait a moment and try again.';
      case 'VALIDATION_FAILED':
      case 'CONFLICT':
      case 'FORBIDDEN':
        return error.message;
      default:
        break;
    }
  }

  return 'Something went wrong sending the photo. Try again, and ring the office if it keeps happening.';
}
