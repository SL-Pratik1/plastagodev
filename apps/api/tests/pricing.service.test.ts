import { PricePreviewSchema } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Pricing (M6).
 *
 * ── Why these are the tests that matter ───────────────────────────────────
 * Every number PlastaGo puts in front of a customer comes out of this service,
 * and Risk 1 says it has to match TransVirtual to the cent. A wrong figure here
 * is not a rendering bug — it is an invoice somebody disputes a month later, so
 * the assertions below are on exact strings rather than rounded comparisons.
 */

let repo: ReturnType<typeof createFakeSettingsRepository>;

// A GETTER, not a value: `vi.mock` factories hoist above every import, so the
// fake does not exist yet when this runs.
vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return repo.repository;
  },
}));

const { pricingService } = await import('../src/domains/settings/pricing.service.js');

beforeEach(() => {
  repo = createFakeSettingsRepository();
});

describe('quoting a job', () => {
  /*
   * Matt's own worked example, from the Domain purchase order. This is the
   * number that lands on a real invoice, so it is asserted end to end rather
   * than only in the money helpers.
   */
  it('prices Matt’s Domain job to the cent', async () => {
    const quote = await pricingService.quote({
      rateCardId: 'clarendon-domaine',
      zone: 'sydney',
      expectedAreaM2: 823.41,
      bagCount: 0,
    });

    expect(quote.subtotalExGst).toBe('351.75'); // $220.00 + $131.75
    expect(quote.gst).toBe('35.18');
    expect(quote.totalIncGst).toBe('386.93');
  });

  it('returns a breakdown, not just a total', async () => {
    const quote = await pricingService.quote({
      rateCardId: 'tier-1',
      zone: 'sydney',
      expectedAreaM2: 1000,
      bagCount: 2,
    });

    // "Why is it $416?" is the immediate next question, and a total with no
    // breakdown is how a quote becomes a phone call.
    expect(quote.lines.map((line) => line.code)).toEqual([
      'service-fee',
      'area-charge',
      'recycling-bags',
    ]);
    expect(quote.lines.map((line) => line.amount)).toEqual(['220.00', '160.00', '60.00']);
    expect(quote.subtotalExGst).toBe('440.00');
  });

  it('conforms to the shared contract', async () => {
    const quote = await pricingService.quote({
      rateCardId: 'default',
      zone: 'newcastle',
      expectedAreaM2: 500,
      bagCount: 1,
    });

    // The browser parses this with the same schema, so a shape the contract
    // rejects would fail in the UI rather than here.
    expect(() => PricePreviewSchema.parse(quote)).not.toThrow();
  });

  it('charges the zone the job is in, not the one before it', async () => {
    const sydney = await pricingService.quote({
      rateCardId: 'default',
      zone: 'sydney',
      expectedAreaM2: 1000,
      bagCount: 0,
    });
    const wollongong = await pricingService.quote({
      rateCardId: 'default',
      zone: 'wollongong',
      expectedAreaM2: 1000,
      bagCount: 0,
    });
    const newcastle = await pricingService.quote({
      rateCardId: 'default',
      zone: 'newcastle',
      expectedAreaM2: 1000,
      bagCount: 0,
    });

    expect(sydney.subtotalExGst).toBe('380.00'); // 220 + 160
    expect(wollongong.subtotalExGst).toBe('430.00'); // 250 + 180
    expect(newcastle.subtotalExGst).toBe('450.00'); // 250 + 200
  });

  /*
   * The fixed-price builder's job (Matt, 31:04). A zero area would price it as
   * if the customer had asked for nothing, so it must come back at the call-out
   * fee with a caveat that says why.
   */
  it('prices a job with no area at the call-out fee, and says so', async () => {
    const quote = await pricingService.quote({
      rateCardId: 'wisdom',
      zone: 'sydney',
      expectedAreaM2: null,
      bagCount: 0,
    });

    expect(quote.lines).toHaveLength(1);
    expect(quote.subtotalExGst).toBe('220.00');
    expect(quote.caveat).toContain('purchase order');
  });

  it('omits the area line rather than showing a zero one', async () => {
    const quote = await pricingService.quote({
      rateCardId: 'default',
      zone: 'sydney',
      expectedAreaM2: 0,
      bagCount: 0,
    });

    expect(quote.lines.some((line) => line.code === 'area-charge')).toBe(false);
  });

  it('rounds GST once, on the total', async () => {
    // A subtotal of $351.75 gives $35.175, which must round to $35.18 — not be
    // rounded per line and then summed into something that disagrees with its
    // own breakdown.
    const quote = await pricingService.quote({
      rateCardId: 'default',
      zone: 'sydney',
      expectedAreaM2: 823.41,
      bagCount: 0,
    });

    expect(quote.gst).toBe('35.18');
    expect(quote.totalIncGst).toBe('386.93');
  });

  it('falls back to the default card when a card has no rate for the zone', async () => {
    repo.removeRatesFor('tier-4');

    const quote = await pricingService.quote({
      rateCardId: 'tier-4',
      zone: 'sydney',
      expectedAreaM2: 100,
      bagCount: 0,
    });

    // It prices rather than failing a booking mid-form, but against `default`.
    expect(quote.rateCardLabel).toBe('default rates');
    expect(quote.subtotalExGst).toBe('236.00');
  });

  /*
   * A zone with no rate anywhere is a configuration gap, not a user error.
   * Refusing beats guessing: a job priced at zero is one that gets collected and
   * never invoiced.
   */
  it('refuses to guess when a zone has no rate at all', async () => {
    repo.unprice('newcastle');

    await expect(
      pricingService.quote({
        rateCardId: 'default',
        zone: 'newcastle',
        expectedAreaM2: 100,
        bagCount: 0,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('looks up the card it was asked for', async () => {
    await pricingService.quote({
      rateCardId: 'wisdom',
      zone: 'wollongong',
      expectedAreaM2: 10,
      bagCount: 0,
    });

    // A quote that silently priced against the wrong card would still return a
    // plausible number, so the lookup itself is asserted.
    expect(repo.calls.resolveRate).toEqual([{ rateCardId: 'wisdom', zone: 'wollongong' }]);
  });

  it('does not go looking for bag rates when there are no bags', async () => {
    await pricingService.quote({
      rateCardId: 'default',
      zone: 'sydney',
      expectedAreaM2: 100,
      bagCount: 0,
    });

    expect(repo.calls.findAdditionalService).toEqual([]);
  });
});

describe('pricing an additional service', () => {
  it('prices a fixed charge, and says whether it needs approving', async () => {
    const charge = await pricingService.priceAdditionalService('contamination');

    expect(charge.amountExGst).toBe('90.00');
    // M2.7 — a driver reports contamination; the office approves the charge
    // before it can reach an invoice.
    expect(charge.requiresApproval).toBe(true);
  });

  it('multiplies a fixed charge by its quantity', async () => {
    const charge = await pricingService.priceAdditionalService('recycling-bags', { quantity: 3 });
    expect(charge.amountExGst).toBe('90.00');
  });

  it('applies a percentage against the base it is given', async () => {
    const charge = await pricingService.priceAdditionalService('fuel-levy-percent', {
      baseAmount: '351.75',
    });

    // 10% of $351.75 is $35.175 → $35.18.
    expect(charge.amountExGst).toBe('35.18');
  });

  it('refuses a percentage with nothing to apply it to', async () => {
    // A silent zero here is a fuel levy that never reaches an invoice.
    await expect(pricingService.priceAdditionalService('fuel-levy-percent')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('404s on a service that is not configured', async () => {
    await expect(pricingService.priceAdditionalService('made-up')).rejects.toMatchObject({
      status: 404,
    });
  });
});
