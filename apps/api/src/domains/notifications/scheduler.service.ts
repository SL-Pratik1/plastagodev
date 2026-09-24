import { schedulerEnabled } from '../../config/env.js';
import { todayInSydney } from '../../lib/business-day.js';
import { logger } from '../../lib/logger.js';
import { notificationRepository } from './notification.repository.js';
import { notificationService } from './notification.service.js';

const log = logger.child({ module: 'scheduler' });

/**
 * The clock that runs the jobs nobody presses a button for.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The chase sweep and the readiness reminders were written, tested and never
 * run: nothing called them. The worker process only ever ran a heartbeat, and
 * the two routes that trigger them had no button behind them. So every evening
 * no site was asked "ready for tomorrow?", and no futile pickup, pending charge
 * or unpaid-for-want-of-a-PO invoice was ever chased.
 *
 * ── Why in the API process and not a BullMQ repeatable job ────────────────
 * Because a repeatable job needs Redis and a deployed worker, and neither is
 * guaranteed — `ENABLE_QUEUES` is off wherever there is no Redis, and the worker
 * then exits. The API is always running. Once-only is kept by the database
 * rather than by a queue: every run claims its slot in `scheduledruns` first,
 * so a restart, a deploy or a second instance cannot run the same slot twice.
 *
 * ⚠️ It only runs while the process is awake. A hosting plan that sleeps an
 * idle server skips whatever falls due while it sleeps; the next tick inside
 * the same window catches up, but a whole missed window is missed.
 */

/** How often the clock is read. Short enough that a 3 pm slot starts by 3:05. */
const TICK_MS = 5 * 60_000;

/** The first look, soon after boot — a deploy at 3:10 pm still sends the 3 pm round. */
const FIRST_TICK_MS = 30_000;

/** Sydney's calendar date and hour, which is what every slot below is keyed on. */
export interface SydneyClock {
  date: string;
  hour: number;
}

export interface ScheduledTask {
  name: string;
  /** The occurrence `clock` falls in, or null when the task is not due. */
  slotFor: (clock: SydneyClock) => string | null;
  run: () => Promise<unknown>;
}

/**
 * What runs, and when (Sydney time).
 *
 *  - The queue sweep, once a day from 7 am — the start of the office day. A
 *    process that wakes at 10 am still runs that morning's.
 *  - The readiness reminders, every hour from 3 pm to 8 pm, for sites with a
 *    truck booked tomorrow. Hourly because runs are planned through the
 *    afternoon: a job put on tomorrow's run at 5 pm is still asked, and a site
 *    already asked is not asked again (the send is keyed on job and run date).
 */
export const SCHEDULED_TASKS: readonly ScheduledTask[] = [
  {
    name: 'queue-sweep',
    slotFor: ({ date, hour }) => (hour >= 7 ? date : null),
    run: () => notificationService.runQueueSweep(),
  },
  {
    name: 'readiness-reminders',
    slotFor: ({ date, hour }) =>
      hour >= 15 && hour <= 20 ? `${date}T${String(hour).padStart(2, '0')}` : null,
    run: () => notificationService.runReadinessReminders(),
  },
];

/**
 * The Sydney date and hour of an instant.
 *
 * From `Intl`, which knows the daylight-saving rules, rather than from a fixed
 * offset — a fixed +10 would run every task an hour early for half the year.
 */
export function sydneyClock(now: Date = new Date()): SydneyClock {
  const hourPart = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: 'numeric',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .find((part) => part.type === 'hour');

  return { date: todayInSydney(now), hour: Number(hourPart?.value ?? '0') };
}

/**
 * Runs whatever is due now. Exported for tests and for anybody who wants to
 * trigger a tick by hand; the timer below is the only regular caller.
 *
 * Never throws: a failed task is recorded against its slot, logged, and tried
 * again on a later tick (a few times, not forever — see `claimScheduledRun`).
 */
export async function runDueTasks(
  now: Date = new Date(),
  tasks: readonly ScheduledTask[] = SCHEDULED_TASKS,
): Promise<Array<{ task: string; slot: string; outcome: 'done' | 'failed' }>> {
  const clock = sydneyClock(now);
  const ran: Array<{ task: string; slot: string; outcome: 'done' | 'failed' }> = [];

  for (const task of tasks) {
    const slot = task.slotFor(clock);
    if (slot === null) continue;

    let claimed: boolean;
    try {
      claimed = await notificationRepository.claimScheduledRun(task.name, slot, now);
    } catch (error) {
      // No database, most likely. Nothing ran, so there is nothing to record.
      log.error({ err: error, task: task.name, slot }, 'could not claim a scheduled run');
      continue;
    }
    if (!claimed) continue;

    try {
      const result = await task.run();
      await notificationRepository.finishScheduledRun(
        task.name,
        slot,
        'done',
        JSON.stringify(result ?? null).slice(0, 500),
      );
      log.info({ task: task.name, slot, result }, 'scheduled task ran');
      ran.push({ task: task.name, slot, outcome: 'done' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'failed';
      log.error({ err: error, task: task.name, slot }, 'scheduled task failed');
      await notificationRepository
        .finishScheduledRun(task.name, slot, 'failed', detail.slice(0, 500))
        .catch(() => undefined);
      ran.push({ task: task.name, slot, outcome: 'failed' });
    }
  }

  return ran;
}

let firstTick: NodeJS.Timeout | undefined;
let interval: NodeJS.Timeout | undefined;
let ticking = false;

/** One tick at a time: a slow run must not be overlapped by the next one. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runDueTasks();
  } finally {
    ticking = false;
  }
}

export const scheduler = {
  /** Starts the clock, unless this environment has it switched off. */
  start(): void {
    if (!schedulerEnabled) {
      log.info('scheduler is off here — SCHEDULER_ENABLED=true runs the sweep and reminders');
      return;
    }
    if (interval) return;

    // `unref`: the clock must never be the reason the process stays alive.
    firstTick = setTimeout(() => void tick(), FIRST_TICK_MS);
    firstTick.unref();
    interval = setInterval(() => void tick(), TICK_MS);
    interval.unref();

    log.info(
      { tasks: SCHEDULED_TASKS.map((task) => task.name), everyMinutes: TICK_MS / 60_000 },
      'scheduler started',
    );
  },

  stop(): void {
    if (firstTick) clearTimeout(firstTick);
    if (interval) clearInterval(interval);
    firstTick = undefined;
    interval = undefined;
  },
};
