import {
  CREDENTIAL_TYPE_LABELS,
  CREDENTIAL_TYPES,
  RATE_CARD_LABELS,
  RATE_CARDS,
  ZONES,
  type AdditionalServiceSetting,
  type CredentialTypeSetting,
  type Integration,
  type InvoiceTemplate,
  type NotificationRule,
  type RateCardId,
  type Zone,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo, isMongoConnected } from '../db/mongo.js';
import { SEQUENCE_STARTS } from '../domains/settings/settings.model.js';
import { settingsRepository } from '../domains/settings/settings.repository.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'seed-settings' });

/**
 * Seeds platform settings, rate cards and zone rates (M2.4, M6, W7).
 *
 * ── Why the figures below are copied from the web fixtures ────────────────
 * They are the same rates, services and integrations the console's demo data
 * already shows. That means a screen looks identical whether it is running on
 * mocks or on the real API, so the cutover is not also a change of demo data —
 * and any difference between the two is a real bug rather than different seeds.
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
const ADDITIONAL_SERVICES: AdditionalServiceSetting[] = [
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

/** M8 — defaults only. `$setOnInsert`, so a rule the office has tuned survives. */
const NOTIFICATION_RULES: NotificationRule[] = [
  { event: 'job-booked', sms: true, email: true, includePhotos: false },
  { event: 'job-allocated', sms: true, email: false, includePhotos: false },
  { event: 'driver-on-the-way', sms: true, email: false, includePhotos: false },
  // Completion carries the photos — that is the proof of collection.
  { event: 'job-completed', sms: true, email: true, includePhotos: true },
  { event: 'job-futile', sms: true, email: true, includePhotos: true },
  { event: 'job-rescheduled', sms: true, email: true, includePhotos: false },
  { event: 'upcoming-reminder', sms: true, email: true, includePhotos: false },
];

/**
 * W7 — what each external service is for.
 *
 * ⚠️ No credentials, ever. `state` seeds as `not-configured` and only a real
 * connectivity check moves it, so a fresh environment never claims a connection
 * it does not have.
 */
const INTEGRATIONS: Integration[] = [
  {
    id: 'xero',
    name: 'Xero',
    purpose: 'Push invoices and contacts; pull payment status.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    caveat: 'Credit notes, part-payments and bank reconciliation are v1.1.',
  },
  {
    id: 'twilio',
    name: 'Twilio',
    purpose: 'Customer SMS and SMS one-time codes.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    caveat: null,
  },
  {
    id: 'google-maps',
    name: 'Google Maps Platform',
    purpose: 'Address autocomplete, geocoding, map pins, driver navigation hand-off.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    caveat: 'Route optimisation is out of scope — this is visual clustering only.',
  },
  {
    id: 'm365-smtp',
    name: 'Microsoft 365 — outbound email',
    purpose: 'Completion emails with photos, invoices, reminders.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    // A conscious trade the client chose; it belongs on screen, not in a doc.
    caveat:
      'Throttled to roughly 30 messages a minute and ~10k recipients a day, with weaker bounce handling than a dedicated provider. Fine at ~140 jobs a month.',
  },
  {
    id: 'm365-outlook',
    name: 'Microsoft 365 — monitored mailbox',
    purpose: 'Inbound purchase orders for the extraction pipeline.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    caveat: null,
  },
  {
    id: 'mistral-ocr',
    name: 'Mistral Document AI',
    purpose: 'Extract PO number, account, site and reference from an emailed document.',
    state: 'not-configured',
    lastSuccessAt: null,
    detail: null,
    caveat:
      'Never auto-attach below threshold. Extraction accuracy must be a measured number — log confidence and correction rate from day one.',
  },
];

/** M7.5 — the six shipped layouts. */
const INVOICE_TEMPLATES: InvoiceTemplate[] = [
  {
    id: 'pg-m2',
    name: 'PlastaGo Recycling Invoice (m²)',
    brandId: 'plastago',
    showsWeight: false,
    assignedAccountCount: 0,
  },
  {
    id: 'pg-kg-m2',
    name: 'PlastaGo Recycling Invoice (kg & m²)',
    brandId: 'plastago',
    showsWeight: true,
    assignedAccountCount: 0,
  },
  {
    id: 'pg-m2-only',
    name: 'PlastaGo Recycling Invoice (m² only)',
    brandId: 'plastago',
    showsWeight: false,
    assignedAccountCount: 0,
  },
  {
    id: 'el-m2',
    name: 'EasyLift Recycling Invoice (m²)',
    brandId: 'easylift',
    showsWeight: false,
    assignedAccountCount: 0,
  },
  {
    id: 'el-kg',
    name: 'EasyLift Recycling Invoice (kg)',
    brandId: 'easylift',
    showsWeight: true,
    assignedAccountCount: 0,
  },
  {
    id: 'rcti',
    name: 'RCTI layout',
    brandId: 'plastago',
    showsWeight: false,
    assignedAccountCount: 0,
  },
];

/** F53 / M9.8 — Matt asked for a reminder a month out, per type. */
const CREDENTIAL_TYPE_SETTINGS: CredentialTypeSetting[] = CREDENTIAL_TYPES.map((type) => ({
  type,
  label: CREDENTIAL_TYPE_LABELS[type],
  reminderLeadDays: 30,
  requiredForDrivers: type !== 'crane-ticket-class-4',
}));

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
  const zoneRates = RATE_CARDS.flatMap((rateCardId: RateCardId) =>
    ZONES.map((zone) => ({
      rateCardId,
      zone,
      serviceCharge: ZONE_RATES[zone].serviceCharge,
      ratePerM2: ZONE_RATES[zone].ratePerM2,
    })),
  );

  await settingsRepository.seed({
    rateCards: RATE_CARDS.map((id) => ({
      id,
      label: RATE_CARD_LABELS[id],
      // Their current schedule runs from 1 Apr 2026.
      effectiveFrom: new Date('2026-04-01T00:00:00.000Z'),
    })),
    zoneRates,
    additionalServices: ADDITIONAL_SERVICES,
    notificationRules: NOTIFICATION_RULES,
    integrations: INTEGRATIONS,
    credentialTypes: CREDENTIAL_TYPE_SETTINGS,
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
  Zone rates          ${String(zoneRates.length)}  (${String(RATE_CARDS.length)} cards × ${String(ZONES.length)} zones)
  Additional services ${String(settings.pricing.additionalServices.length)}
  Notification rules  ${String(settings.notifications.rules.length)}
  Integrations        ${String(settings.integrations.length)}
  Invoice templates   ${String(settings.invoicing.templates.length)}
  Credential types    ${String(settings.credentialTypes.length)}

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
