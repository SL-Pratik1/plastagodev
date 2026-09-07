import type { Money, PricePreview, PricePreviewLine, RateCardId, Zone } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { applyRate, centsToMoney, moneyToCents } from '../../lib/money.js';
import { settingsRepository } from './settings.repository.js';

const log = logger.child({ module: 'pricing' });

/**
 * Pricing (M6).
 *
 * ── Why this is its own service rather than part of jobs ──────────────────
 * Three callers need the same answer: the office's create-job preview, the
 * customer portal's live quote, and the invoice that is eventually raised. If
 * each computed it, they would drift — and the way you find out is a customer
 * comparing the quote they were shown with the invoice they were sent.
 *
 * ⚠️ Every figure is computed in INTEGER CENTS and only formatted at the end
 * (§6A.10 #1). Nothing here touches a float, because these numbers must match
 * TransVirtual to the cent (Risk 1).
 */

export interface QuoteInput {
  rateCardId: RateCardId;
  zone: Zone;
  /**
   * Null on a fixed-price builder's job — the PO carries no area (Matt, 31:04).
   * Priced at the call-out fee alone, with a caveat saying so.
   */
  expectedAreaM2: number | null;
  bagCount: number;
}

/** GST is 10% in Australia and is not a setting anybody may change. */
const GST_DIVISOR = 10;

export const pricingService = {
  /**
   * What a job costs, as the office and the customer both see it.
   *
   * Returns a LINE-ITEMISED preview rather than a total, because "why is it
   * $416?" is the immediate next question — and a total with no breakdown is
   * how a quote becomes a phone call.
   */
  async quote(input: QuoteInput): Promise<PricePreview> {
    const rate = await settingsRepository.resolveRate(input.rateCardId, input.zone);

    if (!rate) {
      // A zone with no rate on any card is a configuration gap, not a user
      // error. Refusing beats guessing: a job priced at zero is one that gets
      // collected and never invoiced.
      throw AppError.dependencyUnavailable(
        `No rate is configured for ${input.zone}. The office needs to set one before this can be priced.`,
      );
    }

    if (rate.rateCardId !== input.rateCardId) {
      log.warn(
        { requested: input.rateCardId, used: rate.rateCardId, zone: input.zone },
        'rate card has no entry for this zone — fell back to the default card',
      );
    }

    const lines: PricePreviewLine[] = [];

    /* ── The call-out fee, charged once regardless of size ─────────────── */
    const serviceCents = moneyToCents(rate.serviceCharge);
    lines.push({
      code: 'service-fee',
      description: `Service fee — ${ZONE_NAMES[input.zone]}`,
      quantity: 1,
      unitRate: rate.serviceCharge,
      amount: centsToMoney(serviceCents),
    });

    /* ── Area, where there is one ──────────────────────────────────────── */
    let areaCents = 0;
    if (input.expectedAreaM2 !== null && input.expectedAreaM2 > 0) {
      // `applyRate`, not multiplication: $0.16 has to survive at its own
      // precision or a month of jobs drifts.
      areaCents = applyRate(rate.ratePerM2, input.expectedAreaM2);
      lines.push({
        code: 'area-charge',
        description: 'Plasterboard recycling (per m²)',
        quantity: input.expectedAreaM2,
        unitRate: rate.ratePerM2,
        amount: centsToMoney(areaCents),
      });
    }

    /* ── Recycling bags ────────────────────────────────────────────────── */
    let bagCents = 0;
    if (input.bagCount > 0) {
      const bagRate = await settingsRepository.findAdditionalService('recycling-bags');
      if (bagRate) {
        bagCents = moneyToCents(bagRate.value) * input.bagCount;
        lines.push({
          code: 'recycling-bags',
          description: bagRate.label,
          quantity: input.bagCount,
          unitRate: bagRate.value,
          amount: centsToMoney(bagCents),
        });
      }
    }

    const subtotalCents = serviceCents + areaCents + bagCents;
    // Rounded once, at the end. Rounding each line then summing produces a
    // total that disagrees with its own breakdown by a cent or two.
    const gstCents = Math.round(subtotalCents / GST_DIVISOR);

    return {
      zone: input.zone,
      rateCardLabel: rate.label,
      lines,
      subtotalExGst: centsToMoney(subtotalCents),
      gst: centsToMoney(gstCents),
      totalIncGst: centsToMoney(subtotalCents + gstCents),
      caveat:
        input.expectedAreaM2 === null
          ? 'The area comes from the purchase order, so this shows the call-out fee only. The final invoice will include it.'
          : 'Estimate on your agreed rates. Additional services raised on site — contamination, extra load time — are quoted and approved separately.',
    };
  },

  /**
   * What one additional service costs (M6.5–M6.7).
   *
   * `percentage` services are computed against a base the caller supplies —
   * a fuel levy is a percentage of the job, not a fixed amount.
   */
  async priceAdditionalService(
    code: string,
    options?: { quantity?: number; baseAmount?: Money },
  ): Promise<{ label: string; amountExGst: Money; requiresApproval: boolean }> {
    const service = await settingsRepository.findAdditionalService(code);
    if (!service) throw AppError.notFound(`No additional service is configured for "${code}"`);

    const quantity = options?.quantity ?? 1;

    const cents =
      service.kind === 'fixed'
        ? moneyToCents(service.value) * quantity
        : // A percentage with no base is a configuration error the caller can
          // fix, not a silent zero on an invoice.
          applyPercentage(service.value, options?.baseAmount, code);

    return {
      label: service.label,
      amountExGst: centsToMoney(cents),
      requiresApproval: service.requiresApproval,
    };
  },
};

const ZONE_NAMES: Record<Zone, string> = {
  sydney: 'Sydney',
  wollongong: 'Wollongong',
  newcastle: 'Newcastle',
};

function applyPercentage(percentage: Money, base: Money | undefined, code: string): number {
  if (base === undefined) {
    throw AppError.badRequest(
      `"${code}" is a percentage service and needs an amount to apply to`,
    );
  }
  // Percent → cents: base × pct ÷ 100, done in integers throughout.
  return Math.round((moneyToCents(base) * moneyToCents(percentage)) / 10_000);
}
