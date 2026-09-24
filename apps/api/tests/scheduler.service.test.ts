import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The clock that runs the chase sweep and the readiness reminders (2026-09-24).
 *
 * Neither had ever run: nothing called them. What is pinned here is WHEN each
 * one is due, in Sydney time through a daylight-saving change, and that a slot
 * runs once — the claim itself is covered against a real Mongo in
 * `notifications-schedule.integration.test.ts`.
 */

/** slot key → state, standing in for the unique index on `scheduledruns`. */
const slots = new Map<string, string>();
const finished: Array<{ task: string; slot: string; state: string; detail: string | null }> = [];

vi.mock('../src/domains/notifications/notification.repository.js', () => ({
  notificationRepository: {
    claimScheduledRun: (task: string, slot: string) => {
      const key = `${task}|${slot}`;
      if (slots.has(key)) return Promise.resolve(false);
      slots.set(key, 'running');
      return Promise.resolve(true);
    },
    finishScheduledRun: (task: string, slot: string, state: string, detail: string | null) => {
      slots.set(`${task}|${slot}`, state);
      finished.push({ task, slot, state, detail });
      return Promise.resolve();
    },
  },
}));

const { SCHEDULED_TASKS, runDueTasks, scheduler, sydneyClock } = await import(
  '../src/domains/notifications/scheduler.service.js'
);

beforeEach(() => {
  slots.clear();
  finished.length = 0;
});

const task = (name: string) => {
  const found = SCHEDULED_TASKS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no task ${name}`);
  return found;
};

describe('Sydney time', () => {
  it('reads the hour in Sydney, not UTC', () => {
    // 05:00 UTC on 24 Sept is 3 pm in Sydney (AEST, +10).
    expect(sydneyClock(new Date('2026-09-24T05:00:00.000Z'))).toEqual({ date: '2026-09-24', hour: 15 });
  });

  /* A fixed +10 would run everything an hour early from October to April. */
  it('follows daylight saving', () => {
    // 4 Oct 2026 is the changeover; on 5 Oct Sydney is +11, so 04:00 UTC is 3 pm.
    expect(sydneyClock(new Date('2026-10-05T04:00:00.000Z'))).toEqual({ date: '2026-10-05', hour: 15 });
  });

  it('turns the date over at Sydney midnight', () => {
    // 14:30 UTC on 24 Sept is 00:30 on the 25th in Sydney.
    expect(sydneyClock(new Date('2026-09-24T14:30:00.000Z')).date).toBe('2026-09-25');
  });
});

describe('when each task is due', () => {
  it('runs the chase sweep once a day, from 7 am', () => {
    const sweep = task('queue-sweep');

    expect(sweep.slotFor({ date: '2026-09-25', hour: 6 })).toBeNull();
    expect(sweep.slotFor({ date: '2026-09-25', hour: 7 })).toBe('2026-09-25');
    // Later the same day is the SAME slot — a process that wakes at 10 still runs it once.
    expect(sweep.slotFor({ date: '2026-09-25', hour: 10 })).toBe('2026-09-25');
  });

  it('asks "ready for tomorrow?" every hour from 3 pm to 8 pm', () => {
    const reminders = task('readiness-reminders');

    expect(reminders.slotFor({ date: '2026-09-25', hour: 14 })).toBeNull();
    expect(reminders.slotFor({ date: '2026-09-25', hour: 15 })).toBe('2026-09-25T15');
    expect(reminders.slotFor({ date: '2026-09-25', hour: 20 })).toBe('2026-09-25T20');
    expect(reminders.slotFor({ date: '2026-09-25', hour: 21 })).toBeNull();
  });
});

describe('running what is due', () => {
  const at3pm = new Date('2026-09-24T05:00:00.000Z');

  it('runs a due task and records that it ran', async () => {
    const run = vi.fn(async () => ({ asked: 3 }));

    const ran = await runDueTasks(at3pm, [{ name: 'test', slotFor: () => 'slot-1', run }]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(ran).toEqual([{ task: 'test', slot: 'slot-1', outcome: 'done' }]);
    expect(finished[0]).toMatchObject({ state: 'done', detail: '{"asked":3}' });
  });

  it('runs a slot once, however many ticks fall inside it', async () => {
    const run = vi.fn(async () => undefined);
    const tasks = [{ name: 'test', slotFor: () => 'slot-1', run }];

    await runDueTasks(at3pm, tasks);
    await runDueTasks(at3pm, tasks);
    await runDueTasks(at3pm, tasks);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips a task that is not due', async () => {
    const run = vi.fn(async () => undefined);

    await runDueTasks(at3pm, [{ name: 'test', slotFor: () => null, run }]);

    expect(run).not.toHaveBeenCalled();
  });

  /* A failure is recorded against its slot, and never thrown at the timer. */
  it('records a failed task instead of throwing', async () => {
    const ran = await runDueTasks(at3pm, [
      { name: 'test', slotFor: () => 'slot-1', run: () => Promise.reject(new Error('Mongo went away')) },
    ]);

    expect(ran).toEqual([{ task: 'test', slot: 'slot-1', outcome: 'failed' }]);
    expect(finished[0]).toMatchObject({ state: 'failed', detail: 'Mongo went away' });
  });

  it('carries on to the next task after one fails', async () => {
    const second = vi.fn(async () => undefined);

    await runDueTasks(at3pm, [
      { name: 'first', slotFor: () => 'slot-1', run: () => Promise.reject(new Error('nope')) },
      { name: 'second', slotFor: () => 'slot-1', run: second },
    ]);

    expect(second).toHaveBeenCalledTimes(1);
  });
});

/*
 * Off unless production or SCHEDULER_ENABLED=true: a laptop pointed at test
 * data must not start raising notifications and texting sites.
 */
it('does not start the clock outside production', () => {
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

  scheduler.start();

  expect(setIntervalSpy).not.toHaveBeenCalled();
  scheduler.stop();
  setIntervalSpy.mockRestore();
});
