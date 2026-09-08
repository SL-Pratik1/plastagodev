import { describe, expect, it } from 'vitest';
import {
  currentMonthInSydney,
  startOfSydneyDay,
  startOfSydneyMonth,
  startOfThisMonth,
  startOfToday,
  todayInSydney,
} from '../src/lib/business-day.js';

/**
 * Day boundaries in the business's own timezone.
 *
 * ── The bug this file exists to prevent ───────────────────────────────────
 * `new Date(`${sydneyDate}T00:00:00.000Z`)` is UTC midnight, which is 10am in
 * Sydney. A "completed today" counter built on it reports nothing until 10am —
 * so it is wrong for the whole morning, which is the only part of the day
 * anybody looks at a dispatch dashboard.
 *
 * The assertions below are the two things that must hold: the instant is really
 * local midnight, and it stays local midnight across both daylight-saving
 * changeovers.
 */

describe('startOfSydneyDay', () => {
  it('is 2pm UTC the day before, in standard time', () => {
    // September is AEST (UTC+10).
    expect(startOfSydneyDay('2026-09-08').toISOString()).toBe('2026-09-07T14:00:00.000Z');
  });

  it('is 1pm UTC the day before, in daylight time', () => {
    // January is AEDT (UTC+11).
    expect(startOfSydneyDay('2026-01-15').toISOString()).toBe('2026-01-14T13:00:00.000Z');
  });

  it('is never UTC midnight, which is the mistake it exists to prevent', () => {
    for (const date of ['2026-01-15', '2026-04-05', '2026-09-08', '2026-10-04']) {
      expect(startOfSydneyDay(date).toISOString()).not.toBe(`${date}T00:00:00.000Z`);
    }
  });

  it('lands on local midnight on the day the clocks go forward', () => {
    /*
     * 4 October 2026 — 2am AEST becomes 3am AEDT. Midnight that morning is
     * still AEST, but the naive single-pass offset lookup samples the offset at
     * 11am local, by which time it is AEDT, and lands an hour early.
     */
    const start = startOfSydneyDay('2026-10-04');

    expect(start.toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(todayInSydney(start)).toBe('2026-10-04');
  });

  it('lands on local midnight on the day the clocks go back', () => {
    // 5 April 2026 — 3am AEDT becomes 2am AEST. Midnight is still AEDT.
    const start = startOfSydneyDay('2026-04-05');

    expect(start.toISOString()).toBe('2026-04-04T13:00:00.000Z');
    expect(todayInSydney(start)).toBe('2026-04-05');
  });

  it('round-trips: the instant it returns is the first moment of that date', () => {
    for (const date of ['2026-01-01', '2026-04-05', '2026-06-30', '2026-10-04', '2026-12-31']) {
      const start = startOfSydneyDay(date);

      expect(todayInSydney(start)).toBe(date);
      // One millisecond earlier belongs to the day before.
      expect(todayInSydney(new Date(start.getTime() - 1))).not.toBe(date);
    }
  });
});

describe('startOfSydneyMonth', () => {
  it('starts on the 1st in local time', () => {
    expect(startOfSydneyMonth('2026-09').toISOString()).toBe('2026-08-31T14:00:00.000Z');
  });

  it('does not leak the last afternoon of the previous month into this one', () => {
    const start = startOfSydneyMonth('2026-09');

    // 31 August, 11pm Sydney. It belongs to August and must fall outside.
    const lastNightOfAugust = new Date('2026-08-31T13:00:00.000Z');

    expect(lastNightOfAugust.getTime()).toBeLessThan(start.getTime());
    expect(currentMonthInSydney(lastNightOfAugust)).toBe('2026-08');
  });

  it('includes the first morning of the month', () => {
    const start = startOfSydneyMonth('2026-09');

    // 1 September, 7am Sydney — a truck completing an early job.
    const firstMorning = new Date('2026-08-31T21:00:00.000Z');

    expect(firstMorning.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(currentMonthInSydney(firstMorning)).toBe('2026-09');
  });
});

describe('todayInSydney', () => {
  it('reads the Sydney date, not the UTC one', () => {
    // 8 September, 9am Sydney is still 7 September in UTC.
    expect(todayInSydney(new Date('2026-09-07T23:00:00.000Z'))).toBe('2026-09-08');
  });

  it('formats as YYYY-MM-DD, the shape the stored date fields use', () => {
    expect(todayInSydney(new Date('2026-01-05T03:00:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the now-relative helpers', () => {
  it('startOfToday is in the past and within 24 hours', () => {
    const start = startOfToday();

    expect(start.getTime()).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - start.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('startOfThisMonth is at or before startOfToday', () => {
    expect(startOfThisMonth().getTime()).toBeLessThanOrEqual(startOfToday().getTime());
  });
});
