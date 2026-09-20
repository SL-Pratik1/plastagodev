/**
 * "Today", as the business reckons it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * PlastaGo runs in Sydney; the browser runs wherever the person is sitting, and
 * the server API answers in Sydney days. `new Date().toISOString().slice(0, 10)`
 * is the UTC day, which is a DIFFERENT day from Sydney's for ten hours out of
 * every twenty-four — every evening, Sydney time.
 *
 * That gap is not academic. The dispatch board defaulted to the UTC day while
 * the driver app asked for the Sydney one, so a run built after 10am UTC was
 * filed under yesterday and the driver's phone showed him an empty day. Same
 * run, two calendars.
 *
 * ⚠️ Anything that means "today", "tomorrow" or "this month" to a person comes
 * through here. Pure arithmetic on a `YYYY-MM-DD` the user already chose does
 * not — that is a plain string and has no timezone to get wrong.
 *
 * Mirrors `apps/api/src/lib/business-day.ts`, deliberately: both sides of the
 * wire have to agree on which day it is. This one carries only the parts a
 * browser needs — the API's instant-boundary maths has no caller here.
 */

const ZONE = 'Australia/Sydney';

/**
 * Today's date in Sydney, as `YYYY-MM-DD`.
 *
 * `en-CA` because it is the one common locale that formats a date in exactly
 * that shape, which is the shape every date field in the system is stored in.
 */
export function todayInSydney(now: Date | number = Date.now()): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: ZONE });
}

/** This month in Sydney, as `YYYY-MM`. */
export function currentMonthInSydney(now: Date | number = Date.now()): string {
  return todayInSydney(now).slice(0, 7);
}

/**
 * A plain `YYYY-MM-DD`, shifted by whole days.
 *
 * Done in UTC on purpose: both ends are calendar dates rather than instants, so
 * there is no zone involved and UTC is simply the arithmetic that has no DST in
 * it to trip over. Feed it `todayInSydney()` when the start point is "today".
 */
export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * The first of the month `months` back from the Sydney month we are in.
 *
 * Counting back from the Sydney month rather than the browser's keeps a report
 * run late on the 30th from quietly starting a month early.
 */
export function firstOfMonthsAgo(months: number, now: Date | number = Date.now()): string {
  const at = new Date(`${currentMonthInSydney(now)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() - months);
  return at.toISOString().slice(0, 10);
}
