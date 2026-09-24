import { describe, expect, it } from 'vitest';

/*
 * A realistic portal address, set BEFORE the messages module reads its
 * environment. The reminder carries a link, and a long one is what pushed it
 * over one SMS.
 */
process.env.PUBLIC_PORTAL_URL = 'https://plasta-go-customer-portal.onrender.com';

const messages = await import('../src/integrations/notice-messages.js');

/**
 * Every text the 2026-09-24 notification fixes send, or reworded, fits ONE SMS.
 *
 * ── Why this is worth a test ──────────────────────────────────────────────
 * One character outside the GSM-7 alphabet — an em dash, a curly apostrophe,
 * the ² of m² — turns a message into UCS-2, where one SMS holds 70 characters
 * instead of 160, and every send is billed two or three times. The invitation
 * text was three SMS for exactly that reason. These are measured, with a long
 * site name, not assumed.
 */

const LONG_SITE = 'Lot 1234 Hawkesbury Ridge Estate Stage 3, Box Hill North';

const job = {
  jobNumber: 61_482,
  siteName: LONG_SITE,
  when: 'Thu, 1 Oct',
  readyFrom: 'Thu, 24 Sept',
  accountName: 'Clarendon Homes',
};

const driverJob = {
  jobNumber: 61_482,
  siteName: LONG_SITE,
  runDay: 'Fri, 25 Sept',
  newReadyFrom: 'Wed, 30 Sept',
};

describe('one SMS each', () => {
  const texts: Array<[string, string]> = [
    ['pickup booked', messages.buildJobBookedSms('0412345678', job).body],
    [
      'ready for tomorrow?',
      messages.buildReadinessSms('0412345678', { ...job, jobId: '6ab4ef7856946b205c661029' }).body,
    ],
    [
      'could not collect',
      messages.buildJobFutileSms('0412345678', {
        ...job,
        jobId: '6ab4ef7856946b205c661029',
        reason: 'Truck access blocked',
      }).body,
    ],
    ['cancelled', messages.buildJobCancelledSms('0412345678', job).body],
    ['new date', messages.buildJobMovedSms('0412345678', job).body],
    ['driver: cancelled', messages.buildDriverJobCancelledSms('0412345678', driverJob).body],
    ['driver: moved off the run', messages.buildDriverJobMovedSms('0412345678', driverJob).body],
  ];

  it.each(texts)('%s', (_name, body) => {
    expect(messages.fitsOneSms(body)).toBe(true);
  });

  it('keeps the link in the reminder, whatever else is dropped', () => {
    const body = messages.buildReadinessSms('0412345678', {
      ...job,
      jobId: '6ab4ef7856946b205c661029',
    }).body;

    expect(body).toContain('https://plasta-go-customer-portal.onrender.com/portal/jobs/6ab4ef7856946b205c661029');
  });
});

describe('typed text that would break GSM-7', () => {
  it('is made safe rather than tripling the bill', () => {
    const body = messages.buildJobCancelledSms('0412345678', {
      ...job,
      siteName: 'O’Brien’s Lot — Stage 2',
    }).body;

    expect(messages.fitsOneSms(body)).toBe(true);
    expect(body).toContain("O'Brien's Lot - Stage 2");
  });
});

describe('fitsOneSms', () => {
  it('counts 160 GSM-7 characters as one SMS and 161 as two', () => {
    expect(messages.fitsOneSms('a'.repeat(160))).toBe(true);
    expect(messages.fitsOneSms('a'.repeat(161))).toBe(false);
  });

  it('refuses a message with a character outside GSM-7', () => {
    expect(messages.fitsOneSms('Collected 42 m² today')).toBe(false);
    expect(messages.fitsOneSms('Sign in — we text you a code')).toBe(false);
  });
});

describe('the booking notice names both dates', () => {
  it('says ready from, and collected by', () => {
    const email = messages.buildJobBookedEmail('site@example.com', job);

    expect(email.text).toContain('ready from Thu, 24 Sept, collected by Thu, 1 Oct');
    expect(email.subject).toContain('ready from Thu, 24 Sept');
  });

  it('falls back to the one date when the ready date is not known', () => {
    const email = messages.buildJobBookedEmail('site@example.com', { ...job, readyFrom: undefined });

    expect(email.text).toContain('booked for Thu, 1 Oct');
  });
});
