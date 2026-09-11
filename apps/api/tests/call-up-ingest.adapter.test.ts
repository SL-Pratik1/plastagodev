import { describe, expect, it } from 'vitest';
import { adaptCallUp } from '../src/domains/queues/call-up-ingest.adapter.js';
import type { ExtractorExtraction } from '../src/integrations/extractor.js';

/**
 * M2.12b — reading a call-up email.
 *
 * ── What is actually under test ───────────────────────────────────────────
 * The date, mostly. Everything else in a call-up notice is a string that either
 * arrives or does not; the date is the one field that can arrive, parse, and be
 * WRONG — and a date read three months out puts a truck at a house that is still
 * a slab.
 *
 * The specific trap is day-first. These are Australian builders: 09/12 is the
 * 9th of December, and `new Date('09/12/2026')` in Node reads it as September.
 */

function extraction(data: Record<string, unknown>): ExtractorExtraction {
  return {
    id: 'ext-1',
    fileName: 'Call up 4500123456.pdf',
    fileType: 'application/pdf',
    status: 'completed',
    extractedData: data,
    error: null,
    documentId: 'doc-call-up',
    documentName: 'Call-up',
    fileUrl: null,
    createdAt: '2026-09-14T02:00:00.000Z',
  } as unknown as ExtractorExtraction;
}

const read = (data: Record<string, unknown>) =>
  adaptCallUp(extraction(data), { receivedAt: new Date('2026-09-14T02:00:00.000Z') });

describe('the date on a call-up', () => {
  /*
   * ⚠️ The one that matters most. Read as month-first this is 12 September —
   * three months early, and the truck arrives at a frame.
   */
  it('reads a slash date day-first, the way Australian builders write it', () => {
    expect(read({ po_number: 'PO1', ready_date: '09/12/2026' })?.input.readyDate).toBe(
      '2026-12-09',
    );
  });

  it('reads an ISO date unchanged', () => {
    expect(read({ po_number: 'PO1', ready_date: '2026-09-21' })?.input.readyDate).toBe(
      '2026-09-21',
    );
  });

  it('reads dots and dashes as well as slashes', () => {
    expect(read({ po_number: 'PO1', ready_date: '21.09.2026' })?.input.readyDate).toBe(
      '2026-09-21',
    );
    expect(read({ po_number: 'PO1', ready_date: '21-09-2026' })?.input.readyDate).toBe(
      '2026-09-21',
    );
  });

  it('reads a two-digit year as this century', () => {
    expect(read({ po_number: 'PO1', ready_date: '21/09/26' })?.input.readyDate).toBe('2026-09-21');
  });

  it('reads a written month', () => {
    expect(read({ po_number: 'PO1', ready_date: '21 September 2026' })?.input.readyDate).toBe(
      '2026-09-21',
    );
    expect(read({ po_number: 'PO1', ready_date: 'Mon 21 Sept 2026' })?.input.readyDate).toBe(
      '2026-09-21',
    );
  });

  /*
   * ⚠️ Refused rather than rolled over. `Date.UTC` turns 31 February into 3
   * March without complaint, and a silently corrected date is worse than a
   * queue item: nobody knows to check it.
   */
  it('refuses a date that does not exist', () => {
    expect(read({ po_number: 'PO1', ready_date: '31/02/2026' })?.input.readyDate).toBeNull();
    expect(read({ po_number: 'PO1', ready_date: '2026-13-01' })?.input.readyDate).toBeNull();
  });

  it('leaves an unreadable date null rather than guessing today', () => {
    expect(read({ po_number: 'PO1', ready_date: 'when the slab is ready' })?.input.readyDate).toBe(
      null,
    );
    expect(read({ po_number: 'PO1' })?.input.readyDate).toBeNull();
  });

  /* And says so, so somebody can fix the template rather than re-key notices. */
  it('records what it could not read', () => {
    const adapted = read({ po_number: 'PO1', ready_date: 'soon' });

    expect(adapted?.missing).toContain('ready_date');
    expect(adapted?.input.note).toContain('Could not read');
  });
});

describe('what kind of notice it is (Matt’s colours, 24:07)', () => {
  it('reads the three words directly', () => {
    expect(read({ po_number: 'PO1', notification_type: 'new' })?.input.kind).toBe('new');
    expect(read({ po_number: 'PO1', notification_type: 'reschedule' })?.input.kind).toBe(
      'reschedule',
    );
    expect(read({ po_number: 'PO1', notification_type: 'cancelled' })?.input.kind).toBe('cancel');
  });

  /* Matt reads these by colour, so the colour words have to work too. */
  it('reads the colours', () => {
    expect(read({ po_number: 'PO1', notification_type: 'Blue' })?.input.kind).toBe('new');
    expect(read({ po_number: 'PO1', notification_type: 'GREEN' })?.input.kind).toBe('reschedule');
    expect(read({ po_number: 'PO1', notification_type: 'red' })?.input.kind).toBe('cancel');
  });

  /* The notices are sentences as often as labels. */
  it('finds the word inside a sentence', () => {
    expect(
      read({ po_number: 'PO1', notification_type: 'Job has been rescheduled to 21/09' })?.input
        .kind,
    ).toBe('reschedule');
  });

  /*
   * ⚠️ Defaults to `new`, and that is the SAFE default of the three: a new
   * booking refuses when the order already has a job, whereas guessing
   * "reschedule" or "cancel" would move or kill real work on no evidence.
   */
  it('defaults an unreadable type to a new booking', () => {
    const adapted = read({ po_number: 'PO1', notification_type: 'FYI' });

    expect(adapted?.input.kind).toBe('new');
    expect(adapted?.missing).toContain('notification_type');
  });

  /* A cancellation names no date, so carrying one would be noise at best. */
  it('drops the date from a cancellation', () => {
    const adapted = read({
      po_number: 'PO1',
      notification_type: 'cancelled',
      ready_date: '2026-09-21',
    });

    expect(adapted?.input.readyDate).toBeNull();
  });
});

describe('the PO number', () => {
  /*
   * The only field with no fallback. Without it the notice cannot be matched to
   * an order now or by a human later, so there is nothing worth queueing.
   */
  it('is refused outright when missing, because nothing can be done with it', () => {
    expect(read({ ready_date: '2026-09-21' })).toBeNull();
    expect(read({ po_number: '   ' })).toBeNull();
  });

  it('survives arriving as a number rather than a string', () => {
    expect(read({ po_number: 4500123456 })?.input.poNumber).toBe('4500123456');
  });
});

describe('what the office sees on the queue row', () => {
  it('carries the email subject and the site, so the row is identifiable', () => {
    const adapted = read({
      po_number: 'PO1',
      ready_date: '2026-09-21',
      notification_type: 'new',
      site_address: '46 Allambie Circuit, Kellyville',
    });

    expect(adapted?.input.note).toContain('Call up 4500123456.pdf');
    expect(adapted?.input.note).toContain('46 Allambie Circuit');
  });

  /* The extraction id is the idempotency key — see the call-up model. */
  it('carries the extraction id so a retried webhook is recognised', () => {
    expect(read({ po_number: 'PO1' })?.input.externalId).toBe('ext-1');
  });

  it('marks it as having come from an email', () => {
    expect(read({ po_number: 'PO1' })?.input.source).toBe('email');
  });
});
