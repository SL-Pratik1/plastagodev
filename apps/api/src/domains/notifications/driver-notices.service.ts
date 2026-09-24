import {
  buildDriverJobCancelledEmail,
  buildDriverJobCancelledSms,
  buildDriverJobMovedEmail,
  buildDriverJobMovedSms,
} from '../../integrations/notice-messages.js';
import { logger } from '../../lib/logger.js';
import { formatDay } from './job-notices.service.js';
import { notificationRepository } from './notification.repository.js';
import { outboundService } from './outbound.service.js';

const log = logger.child({ module: 'driver-notices' });

/**
 * What a driver is told about a job on their run changing under them.
 *
 * ── Why a text, when the phone shows the job anyway ───────────────────────
 * Because the phone shows it only when somebody opens it. A driver already on
 * the road does not refresh the run sheet between stops; a job cancelled at
 * 9 am is a wasted trip at 11 unless something interrupts them. An SMS does.
 *
 * ── Why only these two ────────────────────────────────────────────────────
 * Cancelled, and moved off the run — the two changes that mean "do not go
 * there". A charge decision is deliberately NOT sent to drivers (see the note
 * on `queue.service.ts` `approvalDecide`); this is not the start of a general
 * driver inbox.
 *
 * ⚠️ Never throws. The office's cancel or reschedule has already been written,
 * and a provider being down must not make it look as though it failed.
 */

export interface DriverJobChange {
  driverId: string;
  jobId: string;
  jobNumber: number;
  siteName: string;
  /** The run's date — `YYYY-MM-DD`. */
  runDate: string;
  /** Only on a move: the job's new ready date — `YYYY-MM-DD`. */
  newReadyDate?: string | undefined;
}

export const driverNotices = {
  /** "Job #N on your Friday run is CANCELLED — do not collect it." */
  async jobCancelled(change: DriverJobChange): Promise<void> {
    await notify('driver-job-cancelled', `driver-job-cancelled:${change.jobId}:${change.driverId}`, change, {
      email: buildDriverJobCancelledEmail,
      sms: buildDriverJobCancelledSms,
    });
  },

  /** "Job #N has moved and is off your Friday run — do not collect it." */
  async jobMoved(change: DriverJobChange): Promise<void> {
    await notify(
      'driver-job-moved',
      // The run's date is in the key: a job moved off Friday's run, re-planned
      // onto Monday's and moved again is two different things to be told.
      `driver-job-moved:${change.jobId}:${change.runDate}:${change.driverId}`,
      change,
      { email: buildDriverJobMovedEmail, sms: buildDriverJobMovedSms },
    );
  },
};

async function notify(
  event: string,
  subjectKey: string,
  change: DriverJobChange,
  build: {
    email: typeof buildDriverJobCancelledEmail;
    sms: typeof buildDriverJobCancelledSms;
  },
): Promise<void> {
  try {
    const driver = await notificationRepository.staffContact(change.driverId);
    if (!driver) {
      log.warn({ driverId: change.driverId, jobId: change.jobId, event }, 'driver not found — not told');
      return;
    }

    const context = {
      jobNumber: change.jobNumber,
      siteName: change.siteName,
      runDay: formatDay(change.runDate),
      newReadyFrom: change.newReadyDate ? formatDay(change.newReadyDate) : undefined,
    };

    await outboundService.send({
      event,
      subjectKey,
      /*
       * SMS first: `outboundService` prefers email whenever there is one, and a
       * driver on the road reads texts, not mail. Email only for a driver with
       * no mobile on file at all.
       */
      recipient: driver.mobile
        ? { email: null, mobile: driver.mobile }
        : { email: driver.email, mobile: null },
      email: (to) => build.email(to, context),
      sms: (to) => build.sms(to, context),
      jobId: change.jobId,
    });
  } catch (error) {
    log.error({ err: error, jobId: change.jobId, event }, 'could not tell the driver');
  }
}
