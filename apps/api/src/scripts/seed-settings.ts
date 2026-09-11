import {
  SEEDED_RATE_CARD_LABELS,
  SEEDED_RATE_CARDS,
  ZONES,
  type AdditionalServiceSetting,
  type InvoiceTemplate,
  type RateCardId,
  type Zone,
} from '@plastago/shared';

import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { SEQUENCE_STARTS } from '../domains/settings/settings.model.js';
import { settingsRepository } from '../domains/settings/settings.repository.js';
import { startOfSydneyDay } from '../lib/business-day.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-settings' });

/**
 * A charge as the seed states it.
 *
 * `deletable` is absent because the READ computes it from the protected-code
 * list — the seed states what a charge is, not what may be done to it.
 */
type SeededService = Omit<AdditionalServiceSetting, 'deletable'>;

/**
 * A template as the seed states it.
 *
 * `assignedAccountCount` and `deletable` are absent because both are COUNTED
 * on read — the seed states what a template is, not how many accounts happen
 * to name it today.
 */
type SeededTemplate = Omit<InvoiceTemplate, 'assignedAccountCount' | 'deletable'>;

/**
 * When the seeded schedule opens (M6.2).
 *
 * ⚠️ A `YYYY-MM-DD` string, resolved to the start of the Sydney day by the
 * repository. Their current schedule runs from 1 April 2026, and every seeded
 * card opens on that date so a job dated before it prices nothing rather than
 * silently picking up figures that were not yet agreed.
 */
const SEED_EFFECTIVE_FROM = '2026-04-01';

/**
 * Seeds platform settings, rate cards and zone rates (M2.4, M6).
 *
 * ── Why the figures below are copied from the web fixtures ────────────────
 * They are the same rates and services the console's demo data already shows.
 * That means a screen looks identical whether it is running on mocks or on the
 * real API, so the cutover is not also a change of demo data — and any
 * difference between the two is a real bug rather than different seeds.
 *
 * ⚠️ Idempotent by design. Sequences and anything the office may have since
 * edited are `$setOnInsert`, so re-running never rewinds `nextJobNumber` or
 * undoes a setting somebody changed. See `settingsRepository.seed`.
 *
 *   npm --workspace @plastago/api run seed:settings
 */

/**
 * The three zones, verbatim (M6.3).
 *
 * Decimal STRINGS, never numbers — these have to match TransVirtual to the cent
 * (Risk 1), and a JSON number is a double.
 */
const ZONE_RATES: Record<Zone, { serviceCharge: string; ratePerM2: string }> = {
  sydney: { serviceCharge: '220.00', ratePerM2: '0.16' },
  wollongong: { serviceCharge: '250.00', ratePerM2: '0.18' },
  newcastle: { serviceCharge: '250.00', ratePerM2: '0.20' },
};

/** M6.5–M6.7 — the chargeable extras, and who may raise each. */
const ADDITIONAL_SERVICES: SeededService[] = [
  {
    code: 'contamination',
    label: 'Contamination charge',
    kind: 'fixed',
    value: '90.00',
    // A driver reports it from the fence; the office approves before it can
    // reach an invoice (M2.7).
    requiresApproval: true,
    driverRaisable: true,
    systemGenerated: false,
  },
  {
    code: 'extra-load-time',
    label: 'Extra load time',
    kind: 'fixed',
    value: '100.00',
    requiresApproval: true,
    driverRaisable: false,
    // Raised from the driver's own timestamps — hence *Created By: System*.
    systemGenerated: true,
  },
  {
    code: 'futile-pickup',
    label: 'Futile pickup',
    kind: 'fixed',
    value: '120.00',
    requiresApproval: true,
    driverRaisable: true,
    systemGenerated: false,
  },
  {
    code: 'recycling-bags',
    label: 'Recycling bags',
    kind: 'fixed',
    value: '30.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  {
    code: 'extra-bags',
    label: 'Extra bags (not on the original PO)',
    kind: 'fixed',
    /*
     * The same money as an ordered bag — it is the same bag, collected and
     * tipped identically. What differs is which invoice it may appear on.
     */
    value: '30.00',
    /*
     * Matt, 08:28: *"anything over that original PO needs to get sent off for
     * approval."* The office has to see it before it can be billed, because
     * billing it needs a purchase order that does not exist yet.
     */
    requiresApproval: true,
    // Nobody raises this by hand. It is derived from the driver's bag count
    // against the order's allowance — hence *Created By: System*.
    driverRaisable: false,
    systemGenerated: true,
  },
  {
    code: 'fuel-levy',
    label: 'Fuel levy',
    kind: 'fixed',
    value: '0.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  {
    code: 'fuel-levy-wisdom',
    label: 'Fuel levy — Wisdom',
    kind: 'fixed',
    value: '20.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  {
    code: 'fuel-levy-percent',
    label: 'Fuel levy (10%)',
    kind: 'percentage',
    value: '10',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  {
    code: 'tipping-fuel-levy-percent',
    label: 'Tipping fuel levy (7.5%)',
    kind: 'percentage',
    value: '7.5',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  {
    code: 'out-of-area',
    label: 'Out of area',
    kind: 'fixed',
    value: '2.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
];

/**
 * M7.5 — the five shipped templates.
 *
 * ── Why five and not the six that were here before ───────────────────────
 * `pg-m2-only` was byte-for-byte identical to `pg-m2`: same brand, same
 * columns, a different name. Two templates that produce the same document are
 * a choice the office has to make with no way to make it correctly, so the
 * duplicate is gone.
 *
 * What varies across the five is real: the BRAND on the letterhead, whether
 * kilograms print beside square metres, and — for the RCTI — the document type
 * itself. Anything that does not change the document does not earn a row.
 */
const INVOICE_TEMPLATES: SeededTemplate[] = [
  {
    id: 'pg-m2',
    name: 'PlastaGo Recycling Invoice (m²)',
    brandId: 'plastago',
    showsWeight: false,
    layout: 'standard',
    accentColour: '#1a4d3a',
  },
  {
    id: 'pg-kg-m2',
    name: 'PlastaGo Recycling Invoice (kg & m²)',
    brandId: 'plastago',
    showsWeight: true,
    // The detailed drawing, because an account billed by weight is one whose
    // accounts department reconciles against a docket — so the site and the
    // collection date have to be on the page.
    layout: 'detailed',
    accentColour: '#1a4d3a',
  },
  {
    id: 'el-m2',
    name: 'EasyLift Recycling Invoice (m²)',
    brandId: 'easylift',
    showsWeight: false,
    layout: 'standard',
    accentColour: '#0f5c7a',
  },
  {
    id: 'el-kg',
    name: 'EasyLift Recycling Invoice (kg)',
    brandId: 'easylift',
    showsWeight: true,
    layout: 'detailed',
    accentColour: '#0f5c7a',
  },
  {
    id: 'rcti',
    name: 'RCTI — recipient created tax invoice',
    brandId: 'plastago',
    showsWeight: false,
    layout: 'rcti',
    /*
     * Visibly different on purpose. An RCTI is raised by the CUSTOMER, and one
     * that looks like an ordinary PlastaGo invoice is one somebody files as an
     * ordinary invoice — and then pays twice, or not at all.
     */
    accentColour: '#7a4a0f',
  },
];

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('seed-settings refuses to run with NODE_ENV=production');
  }

  await connectMongo();
  if (!isMongoConnected()) {
    throw new Error('Could not reach MongoDB — is it running?');
  }

  /*
   * Every card carries all three zones. A card with a missing zone would fall
   * back to `default` at quote time, which is a safety net rather than a plan —
   * the office should never be quoting from a card it did not choose.
   */
  const zoneRates = SEEDED_RATE_CARDS.flatMap((rateCardId: RateCardId) =>
    ZONES.map((zone) => ({
      rateCardId,
      zone,
      serviceCharge: ZONE_RATES[zone].serviceCharge,
      ratePerM2: ZONE_RATES[zone].ratePerM2,
      effectiveFrom: SEED_EFFECTIVE_FROM,
    })),
  );

  await settingsRepository.seed({
    rateCards: SEEDED_RATE_CARDS.map((id) => ({
      id,
      label: SEEDED_RATE_CARD_LABELS[id],
      // Start of the Sydney day, not UTC midnight — the same instant the
      // schedule rows below are written at, so a card and its opening
      // schedule cannot disagree by eleven hours.
      effectiveFrom: startOfSydneyDay(SEED_EFFECTIVE_FROM),
    })),
    zoneRates,
    additionalServices: ADDITIONAL_SERVICES,
    invoiceTemplates: INVOICE_TEMPLATES,
    // M6.8 — a placeholder until real cost data exists, which is exactly why it
    // is a setting rather than a constant.
    assumedCostPerJob: '100.00',
  });

  log.info('settings seeded');

  const settings = await settingsRepository.get();

  // eslint-disable-next-line no-console
  console.log(`
Seeded settings into "${mongoose.connection.name}".

  Rate cards          ${String(settings.pricing.rateCards.length)}
  Zone rates          ${String(zoneRates.length)}  (${String(SEEDED_RATE_CARDS.length)} cards × ${String(ZONES.length)} zones)
  Additional services ${String(settings.pricing.additionalServices.length)}
  Invoice templates   ${String(settings.invoicing.templates.length)}

  Next job number     ${String(SEQUENCE_STARTS.nextJobNumber)}  (start; advances as jobs are raised)
  Next invoice number ${String(SEQUENCE_STARTS.nextInvoiceNumber)}  (start; advances as invoices are raised)

Sydney is $220.00 + $0.16/m²; Wollongong $250.00 + $0.18; Newcastle $250.00 + $0.20.
`);
}

await main()
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMongo();
  });
