import { AppError } from './app-error.js';
import { isPlausibleReadyDate } from './business-day.js';

/**
 * Refuse a ready date that cannot be meant.
 *
 * ⚠️ Lives in `lib/` rather than in the jobs domain because a ready date is set
 * from two places: booking and rescheduling in `jobs`, and the reschedule that
 * closes a futile review in `queues`. It was written in `jobs` first and the
 * futile queue walked straight past it — a review could be closed with a ready
 * date six years old, which is the same job left permanently at the top of
 * every at-risk list.
 *
 * The window itself, and why back-dating stays allowed, is on
 * `isPlausibleReadyDate`. `path` is a parameter because the two callers name
 * the field differently: `readyDate` on a booking, `newReadyDate` on the futile
 * form, and the message has to point at the control the user can actually fix.
 */
export function assertPlausibleReadyDate(isoDate: string, path = 'readyDate'): void {
  const verdict = isPlausibleReadyDate(isoDate);
  if (verdict.ok) return;

  if (verdict.direction === 'past') {
    throw AppError.validation('That ready date is more than a year ago', [
      {
        path,
        message: `Check the year. A job ready on ${isoDate} would be overdue the moment it is saved.`,
      },
    ]);
  }

  throw AppError.validation('That ready date is more than a year away', [
    { path, message: `Check the year — ${isoDate} is further out than we book.` },
  ]);
}
