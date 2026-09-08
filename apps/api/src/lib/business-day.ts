/**
 * Day and month boundaries in the business's own timezone.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * PlastaGo runs in Sydney, and almost every date in the system is stored as a
 * plain `YYYY-MM-DD` string — a ready date, a target date, an invoice date. Those
 * compare against `todayInSydney()` as strings and need nothing else.
 *
 * The trap is the OTHER kind of field: `completedAt`, `raisedAt`, `markedAt` are
 * instants, and counting "today's" instants means knowing the UTC moment the
 * Sydney day began. Writing `new Date(`${today}T00:00:00.000Z`)` looks like it
 * does that and does not — it is UTC midnight, which is 10am in Sydney. A
 * "completed today" counter built that way reports zero all morning and only
 * starts counting at 10am, which is precisely when nobody is looking at it any
 * more.
 *
 * ⚠️ Anything comparing a Date against "the start of today" must come through
 * here. String dates must not: `todayInSydney()` is already the right shape for
 * those.
 */

const ZONE = 'Australia/Sydney';

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Today's date in Sydney, as `YYYY-MM-DD`. The shape stored date fields use. */
export function todayInSydney(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: ZONE });
}

/** This month in Sydney, as `YYYY-MM`. */
export function currentMonthInSydney(now: Date = new Date()): string {
  return todayInSydney(now).slice(0, 7);
}

/**
 * The UTC instant at which a Sydney calendar day begins.
 *
 * ── Why it measures the offset twice ──────────────────────────────────────
 * The offset is not a constant — Sydney is +10 for half the year and +11 for the
 * other half. To subtract the right one you have to know the offset AT LOCAL
 * MIDNIGHT, and to know that you need the instant you are trying to compute.
 *
 * So the first pass uses the offset at UTC midnight, which lands within an hour
 * of the answer, and the second pass measures the offset there. On the two
 * changeover days a year that second pass is the difference between the right
 * hour and the wrong one; on the other 363 both passes agree.
 */
export function startOfSydneyDay(isoDate: string): Date {
  const utcMidnight = Date.parse(`${isoDate}T00:00:00.000Z`);

  const firstPass = utcMidnight - offsetMinutesAt(new Date(utcMidnight)) * 60_000;

  return new Date(utcMidnight - offsetMinutesAt(new Date(firstPass)) * 60_000);
}

/** The UTC instant at which a Sydney calendar month begins. */
export function startOfSydneyMonth(isoMonth: string): Date {
  return startOfSydneyDay(`${isoMonth}-01`);
}

/** The UTC instant at which the Sydney day containing `now` began. */
export function startOfToday(now: Date = new Date()): Date {
  return startOfSydneyDay(todayInSydney(now));
}

/** The UTC instant at which the Sydney month containing `now` began. */
export function startOfThisMonth(now: Date = new Date()): Date {
  return startOfSydneyMonth(currentMonthInSydney(now));
}

/**
 * How far ahead of UTC Sydney is at a given instant, in minutes (600 or 660).
 *
 * Read by asking Intl what Sydney's wall clock said at that instant, then
 * treating that reading as if it were UTC. The gap between the two is the
 * offset — which is what "offset" means, and avoids hard-coding DST rules that
 * a government can change.
 */
function offsetMinutesAt(at: Date): number {
  const parts = FORMATTER.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };

  const wallClockAsUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    // Some ICU builds render midnight as hour 24 under hour12: false.
    read('hour') % 24,
    read('minute'),
    read('second'),
  );

  return (wallClockAsUtc - at.getTime()) / 60_000;
}
