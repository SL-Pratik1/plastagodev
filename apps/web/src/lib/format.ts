import { APP_TIMEZONE } from '@plastago/shared';

/**
 * Every date, time and amount in the console goes through this file.
 *
 * Two non-negotiables from §6A.10 are enforced here rather than trusted to each
 * screen, because both fail silently:
 *
 *  #1 **Money is a decimal string, never a `number`.** JSON numbers are
 *     IEEE-754 doubles and will quietly lose cents. GST and rounding must match
 *     TransVirtual to the cent (Risk 1), so `formatMoney` takes a string and
 *     groups the digits textually — it never calls `Number()`.
 *
 *  #5 **Store UTC, render Australia/Sydney.** The office reads Sydney time; the
 *     migrated data is coming out of TransVirtual in NZST/NZDT (M10.4). A
 *     browser-local format would be right in the Sydney office and wrong for
 *     anyone reviewing from elsewhere, which is the worst kind of bug: invisible
 *     to the person who could spot it.
 */

/** Reused rather than reconstructed — `Intl` formatters are expensive to build. */
const dateFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIMEZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const timeFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dayFormatter = new Intl.DateTimeFormat('en-AU', {
  timeZone: APP_TIMEZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** Shown wherever a bare date could be mistaken for browser-local time. */
export const TIMEZONE_LABEL = 'Australia/Sydney';

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `25 Aug 2026` */
export function formatDate(iso: string | null | undefined, fallback = '—'): string {
  const date = parse(iso);
  return date ? dateFormatter.format(date) : fallback;
}

/** `25 Aug 2026, 14:32` */
export function formatDateTime(iso: string | null | undefined, fallback = '—'): string {
  const date = parse(iso);
  return date ? dateTimeFormatter.format(date) : fallback;
}

/** `14:32` */
export function formatTime(iso: string | null | undefined, fallback = '—'): string {
  const date = parse(iso);
  return date ? timeFormatter.format(date) : fallback;
}

/** `Tue 25 Aug` — for run sheets and day columns. */
export function formatDay(iso: string | null | undefined, fallback = '—'): string {
  const date = parse(iso);
  return date ? dayFormatter.format(date) : fallback;
}

/**
 * `2 minutes ago`, `in 5 minutes`.
 *
 * Used for queue ageing and "last synced", where the elapsed time is the point
 * and an absolute timestamp makes the reader do arithmetic.
 */
export function formatRelative(iso: string | null | undefined, fallback = '—'): string {
  const date = parse(iso);
  if (!date) return fallback;

  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  const formatter = new Intl.RelativeTimeFormat('en-AU', { numeric: 'auto' });

  if (absolute < 45) return formatter.format(Math.round(deltaSeconds), 'second');
  if (absolute < 45 * 60) return formatter.format(Math.round(deltaSeconds / 60), 'minute');
  if (absolute < 22 * 3600) return formatter.format(Math.round(deltaSeconds / 3600), 'hour');
  return formatter.format(Math.round(deltaSeconds / 86400), 'day');
}

/** Seconds remaining until `iso`, floored at zero. Drives resend cooldowns. */
export function secondsUntil(iso: string | null | undefined): number {
  const date = parse(iso);
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

/**
 * `"220.00"` → `"$220.00"`, without ever creating a `number`.
 *
 * The integer part is grouped by string manipulation and the fraction is padded
 * to two places. `Number(value).toLocaleString()` would be shorter and is
 * exactly the mistake §6A.10 #1 forbids.
 */
export function formatMoney(
  value: string | null | undefined,
  options: { currency?: boolean; fallback?: string } = {},
): string {
  const { currency = true, fallback = '—' } = options;
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^-?\d+(\.\d+)?$/.test(value)) return fallback;

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = fraction.padEnd(2, '0').slice(0, 2);

  return `${negative ? '-' : ''}${currency ? '$' : ''}${grouped}.${cents}`;
}

/**
 * Area in m² and mass in kg are two different quantities, not two units of one
 * (M1.3, M4.3) — m² is what gets priced, kg is what was recovered. Separate
 * formatters so no screen can accidentally show one labelled as the other.
 */
export function formatArea(squareMetres: number | null | undefined, fallback = '—'): string {
  if (squareMetres === null || squareMetres === undefined) return fallback;
  return `${squareMetres.toLocaleString('en-AU')} m²`;
}

/**
 * An invoice number as it is shown and quoted — "PGA-104312".
 *
 * Matt, 7:07 asked for a configurable prefix. It is applied at RENDER time,
 * never stored: the stored number is a bare sequence that Xero matches on and
 * that must never collide, so changing the prefix in settings has to leave every
 * existing invoice numbered exactly as it was.
 *
 * The hyphen is part of the presentation rather than the setting, so nobody has
 * to remember to type it — and so "PGA" and "PGA-" cannot both end up in use.
 */
export function formatInvoiceNumber(invoiceNumber: number, prefix = ''): string {
  const clean = prefix.trim();
  return clean === '' ? `#${String(invoiceNumber)}` : `${clean}-${String(invoiceNumber)}`;
}

export function formatWeight(kilograms: number | null | undefined, fallback = '—'): string {
  if (kilograms === null || kilograms === undefined) return fallback;
  if (kilograms >= 1000) return `${(kilograms / 1000).toLocaleString('en-AU')} t`;
  return `${kilograms.toLocaleString('en-AU')} kg`;
}

/** `0412 345 678` — how an Australian mobile is read aloud and written down. */
export function formatMobile(mobile: string | null | undefined, fallback = '—'): string {
  if (!mobile) return fallback;
  const digits = mobile.replace(/\D/g, '');
  if (digits.length !== 10) return mobile;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

/** `1` → `1st`. Used in run sheet stop numbers. */
export function formatCount(value: number, singular: string, plural?: string): string {
  const word = value === 1 ? singular : (plural ?? `${singular}s`);
  return `${value.toLocaleString('en-AU')} ${word}`;
}
