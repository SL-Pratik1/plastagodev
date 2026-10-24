import { ZoneRateInputSchema, hasAtMostTwoDecimals, pickupName } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fixed prices on a rate card (show-and-tell, 21 Oct 2026).
 *
 * Matt: *"it's still a two-part charge"* — a service fee, then a weight charge
 * that is either m² × rate or a fixed amount per zone (Wisdom: $190 + $112).
 * Hook bins are a set price per zone. These tests pin the three ways the
 * second charge is priced, and what reaches the job and its invoice.
 */

type Rate = {
  rateCardId: string;
  label: string;
  zoneId: string;
  zoneLabel: string;
  serviceCharge: string;
  ratePerM2: string;
  weightChargeKind: 'per-m2' | 'fixed';
  fixedWeightCharge: string | null;
  hookBin5: string | null;
  hookBin10: string | null;
  hookBin15: string | null;
  scheduleFrom: string;
};

const SYDNEY = '000000000000000000000001';

let rate: Rate;

vi.mock('../src/domains/settings/settings.repository.js', () => ({
  settingsRepository: {
    resolveRate: () => Promise.resolve(rate),
    findZoneLabel: () => Promise.resolve('Sydney'),
    findAdditionalService: () =>
      Promise.resolve({ code: 'recycling-bags', label: 'Recycling bags', value: '30.00' }),
  },
}));

const { pricingService } = await import('../src/domains/settings/pricing.service.js');

function quote(overrides: Partial<Parameters<typeof pricingService.quote>[0]> = {}) {
  return pricingService.quoteWithAppliedRate({
    rateCardId: 'wisdom',
    zoneId: SYDNEY,
    expectedAreaM2: 823.41,
    bagCount: 0,
    freightItem: 'plasterboard-bagged',
    onDate: '2026-10-22',
    ...overrides,
  });
}

beforeEach(() => {
  rate = {
    rateCardId: 'wisdom',
    label: 'Wisdom Homes',
    zoneId: SYDNEY,
    zoneLabel: 'Sydney',
    serviceCharge: '190.00',
    ratePerM2: '0.16',
    weightChargeKind: 'per-m2',
    fixedWeightCharge: null,
    hookBin5: '350.00',
    hookBin10: null,
    hookBin15: '0.00',
    scheduleFrom: '2026-10-01',
  };
});

describe('a per-m² zone line', () => {
  it('charges the service fee plus m² × rate, as before', async () => {
    const { preview, appliedRate } = await quote();

    expect(preview.lines.map((line) => [line.code, line.amount])).toEqual([
      ['service-fee', '190.00'],
      ['area-charge', '131.75'],
    ]);
    expect(preview.subtotalExGst).toBe('321.75');
    expect(preview.areaPriced).toBe(true);
    expect(appliedRate).toMatchObject({ weightChargeKind: 'per-m2', weightCharge: null });
  });
});

describe('a fixed zone line', () => {
  beforeEach(() => {
    rate.weightChargeKind = 'fixed';
    rate.fixedWeightCharge = '112.00';
    rate.ratePerM2 = '0';
  });

  it('charges the service fee plus the fixed "Weight charge", whatever the area', async () => {
    const small = await quote({ expectedAreaM2: 10 });
    const large = await quote({ expectedAreaM2: 2_000 });

    for (const { preview } of [small, large]) {
      expect(preview.lines).toEqual([
        expect.objectContaining({ code: 'service-fee', amount: '190.00' }),
        {
          code: 'weight-charge',
          description: 'Weight charge',
          quantity: 1,
          unitRate: '112.00',
          amount: '112.00',
        },
      ]);
      expect(preview.subtotalExGst).toBe('302.00');
    }
  });

  it('needs no area, and does not say the area is missing', async () => {
    const { preview } = await quote({ expectedAreaM2: null });

    expect(preview.subtotalExGst).toBe('302.00');
    expect(preview.areaPriced).toBe(false);
    expect(preview.caveat).not.toMatch(/call-out fee only/);
  });

  it('freezes the fixed amount onto the job', async () => {
    const { appliedRate } = await quote();

    expect(appliedRate).toMatchObject({ weightChargeKind: 'fixed', weightCharge: '112.00' });
  });

  it('still adds the recycling bags on top', async () => {
    const { preview } = await quote({ bagCount: 2 });

    expect(preview.subtotalExGst).toBe('362.00');
  });
});

describe('a hook bin', () => {
  it('charges the service fee plus the bin’s set price for the zone', async () => {
    const { preview, appliedRate } = await quote({ freightItem: 'hook-bin-5' });

    expect(preview.lines.map((line) => [line.code, line.description, line.amount])).toEqual([
      ['service-fee', 'Service fee — Sydney', '190.00'],
      ['hook-bin', 'Hook bin 5 m³', '350.00'],
    ]);
    expect(preview.areaPriced).toBe(false);
    expect(appliedRate).toMatchObject({ weightChargeKind: 'hook-bin', weightCharge: '350.00' });
  });

  it('ignores the card’s fixed weight charge — the bin is the second charge', async () => {
    rate.weightChargeKind = 'fixed';
    rate.fixedWeightCharge = '112.00';

    const { preview } = await quote({ freightItem: 'hook-bin-5' });

    expect(preview.subtotalExGst).toBe('540.00');
  });

  it('refuses a bin the card does not offer, naming the field', async () => {
    await expect(quote({ freightItem: 'hook-bin-10' })).rejects.toMatchObject({
      status: 422,
      issues: [{ path: 'freightItem' }],
    });
  });

  /* Matt: *"if they're on the rate card as $0.00, then that's not an option."* */
  it('treats a $0.00 bin as not offered', async () => {
    await expect(quote({ freightItem: 'hook-bin-15' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('writing a zone line', () => {
  it('keeps an older caller working — no kind means per m², no bins', () => {
    const parsed = ZoneRateInputSchema.parse({
      zoneId: SYDNEY,
      serviceCharge: '220.00',
      ratePerM2: '0.16',
    });

    expect(parsed).toMatchObject({
      weightChargeKind: 'per-m2',
      fixedWeightCharge: null,
      hookBin5: null,
      hookBin10: null,
      hookBin15: null,
    });
  });

  it('refuses a fixed line with no amount', () => {
    const result = ZoneRateInputSchema.safeParse({
      zoneId: SYDNEY,
      serviceCharge: '190.00',
      ratePerM2: '0',
      weightChargeKind: 'fixed',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['fixedWeightCharge']);
  });

  it('refuses a negative hook-bin price', () => {
    expect(
      ZoneRateInputSchema.safeParse({
        zoneId: SYDNEY,
        serviceCharge: '190.00',
        ratePerM2: '0.16',
        hookBin5: '-10.00',
      }).success,
    ).toBe(false);
  });
});

describe('the pickup name and the exact m² (Batch 1 #15)', () => {
  it('builds "Lot 214, 12 Smith Street", or the street alone', () => {
    expect(pickupName('214', '12 Smith Street')).toBe('Lot 214, 12 Smith Street');
    expect(pickupName('Lot 214', '12 Smith Street')).toBe('Lot 214, 12 Smith Street');
    expect(pickupName('  ', ' 12 Smith Street ')).toBe('12 Smith Street');
  });

  it('never exceeds what a site name holds', () => {
    expect(pickupName('9'.repeat(30), 'x'.repeat(160))).toHaveLength(120);
  });

  it('accepts 972.62 and refuses a third decimal', () => {
    expect(hasAtMostTwoDecimals(972.62)).toBe(true);
    expect(hasAtMostTwoDecimals(850)).toBe(true);
    expect(hasAtMostTwoDecimals(972.625)).toBe(false);
  });
});
