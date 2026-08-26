import {
  APP_TIMEZONE,
  CREDENTIAL_TYPE_LABELS,
  CREDENTIAL_TYPES,
  DATA_REGION,
  RATE_CARD_LABELS,
  RATE_CARDS,
  ZONE_LABELS,
  type Integration,
  type Settings,
} from '@plastago/shared';
import { ServiceError } from '../service-error';
import type { SettingsService } from '../types';
import { ACCOUNTS, ZONE_RATES, centsToMoney } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';

/**
 * Settings (W3, M1.1, M6, M7.5, W7).
 *
 * ── What is editable and what is a stated fact ────────────────────────────
 * Data residency, the 7-year retention floor and the timezone are commitments in
 * the client's Privacy Policy (M1.7) — they are displayed, never edited. Number
 * sequences continue from ~61,300 and ~104,100 and need a transactional counter
 * (M1.4), so the current value is shown rather than offered as a text box.
 *
 * Rate cards are effective-dated (M6.2): pricing a job always uses the rates in
 * force on that job's date, so "changing a rate" means issuing a new schedule.
 * That is why there is no save method for pricing here — getting it wrong would
 * silently reprice history, and Risk 1 is the highest-rated risk in the project.
 */
function defaults(): Settings {
  const zones = (Object.keys(ZONE_LABELS) as Array<keyof typeof ZONE_LABELS>).map((zone) => ({
    zone,
    serviceCharge: centsToMoney(ZONE_RATES[zone].serviceCents),
    ratePerM2: centsToMoney(ZONE_RATES[zone].perM2Cents),
  }));

  const nextJobNumber = Math.max(...store.jobs.map((job) => job.jobNumber)) + 1;

  const integrations: Integration[] = [
    {
      id: 'xero',
      name: 'Xero',
      purpose: 'Push invoices and contacts; pull payment status.',
      state: 'connected',
      lastSuccessAt: new Date(Date.now() - 42 * 60_000).toISOString(),
      detail: 'Credit notes, part-payments and bank reconciliation are v1.1.',
      caveat: null,
    },
    {
      id: 'twilio',
      name: 'Twilio',
      purpose: 'Customer SMS and SMS one-time codes.',
      state: 'connected',
      lastSuccessAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      detail: null,
      caveat: null,
    },
    {
      id: 'google-maps',
      name: 'Google Maps Platform',
      purpose: 'Address autocomplete, geocoding, map pins, driver navigation hand-off.',
      state: 'not-configured',
      lastSuccessAt: null,
      detail: 'No API key configured, so the dispatch map plots coordinates without tiles.',
      caveat: 'Route optimisation is out of scope — this is visual clustering only.',
    },
    {
      id: 'm365-smtp',
      name: 'Microsoft 365 — outbound email',
      purpose: 'Completion emails with photos, invoices, reminders.',
      state: 'connected',
      lastSuccessAt: new Date(Date.now() - 18 * 60_000).toISOString(),
      detail: null,
      // A conscious trade the client chose; it belongs on screen, not in a doc.
      caveat:
        'Throttled to roughly 30 messages a minute and ~10k recipients a day, with weaker bounce handling than a dedicated provider. Fine at ~140 jobs a month.',
    },
    {
      id: 'm365-outlook',
      name: 'Microsoft 365 — monitored mailbox',
      purpose: 'Inbound purchase orders for the extraction pipeline.',
      state: 'connected',
      lastSuccessAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      detail: null,
      caveat: null,
    },
    {
      id: 'mistral-ocr',
      name: 'Mistral Document AI',
      purpose: 'Extract PO number, account, site and reference from an emailed document.',
      state: 'error',
      lastSuccessAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
      detail:
        'Last batch returned 3 extractions below the confidence threshold; they are queued for review.',
      caveat:
        'Never auto-attach below threshold. Extraction accuracy must be a measured number — log confidence and correction rate from day one.',
    },
  ];

  return {
    general: {
      slaBusinessDays: 5,
      timezone: APP_TIMEZONE,
      dataRegion: DATA_REGION,
      retentionYears: 7,
      nextJobNumber,
      nextInvoiceNumber: 104_100 + store.jobs.filter((job) => job.invoiceNumber !== null).length,
      zones,
    },

    notifications: {
      rules: [
        { event: 'job-booked', sms: true, email: true, includePhotos: false },
        { event: 'job-allocated', sms: true, email: false, includePhotos: false },
        { event: 'driver-on-the-way', sms: true, email: false, includePhotos: false },
        { event: 'job-completed', sms: true, email: true, includePhotos: true },
        { event: 'job-futile', sms: true, email: true, includePhotos: true },
        { event: 'job-rescheduled', sms: true, email: true, includePhotos: false },
        { event: 'upcoming-reminder', sms: true, email: true, includePhotos: false },
      ],
      reminderLeadDays: 1,
      reminderIncludeRescheduleLink: true,
      queueDigestEnabled: true,
      queueDigestHour: 7,
    },

    pricing: {
      rateCards: RATE_CARDS.map((id) => ({
        id,
        label: RATE_CARD_LABELS[id],
        accountCount: ACCOUNTS.filter((account) => account.rateCardId === id).length,
        // Their current schedule runs 1 Apr 2026 → 1 Apr 2051.
        effectiveFrom: '2026-04-01',
        effectiveTo: '2051-04-01',
        zones,
      })),
      additionalServices: [
        {
          code: 'contamination',
          label: 'Contamination charge',
          kind: 'fixed',
          value: '90.00',
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
          code: 'futile-pickup',
          label: 'Futile pickup',
          kind: 'fixed',
          value: '120.00',
          requiresApproval: true,
          driverRaisable: true,
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
          code: 'tipping-fuel-levy-percent',
          label: 'Tipping fuel levy (7.5%)',
          kind: 'percentage',
          value: '7.5',
          requiresApproval: false,
          driverRaisable: false,
          systemGenerated: false,
        },
      ],
      assumedCostPerJob: '100.00',
    },

    invoicing: {
      // The six shipped templates (M7.5).
      templates: [
        {
          id: 'pg-m2',
          name: 'PlastaGo Recycling Invoice (m²)',
          brandId: 'plastago',
          showsWeight: false,
          assignedAccountCount: 4,
        },
        {
          id: 'pg-kg-m2',
          name: 'PlastaGo Recycling Invoice (kg & m²)',
          brandId: 'plastago',
          showsWeight: true,
          assignedAccountCount: 3,
        },
        {
          id: 'pg-m2-only',
          name: 'PlastaGo Recycling Invoice (m² only)',
          brandId: 'plastago',
          showsWeight: false,
          assignedAccountCount: 2,
        },
        {
          id: 'el-m2',
          name: 'EasyLift Recycling Invoice (m²)',
          brandId: 'easylift',
          showsWeight: false,
          assignedAccountCount: 1,
        },
        {
          id: 'el-kg',
          name: 'EasyLift Recycling Invoice (kg)',
          brandId: 'easylift',
          showsWeight: true,
          assignedAccountCount: 1,
        },
        {
          id: 'rcti',
          name: 'RCTI layout',
          brandId: 'plastago',
          showsWeight: false,
          assignedAccountCount: 0,
        },
      ],
      splitAdditionalCharges: true,
      defaultPaymentTermsDays: 7,
      footerText: 'PlastaGo — a better way with plasterboard recycling. GBCA Member 2026-2027.',
      bankBsb: '082-343',
      bankAccount: '45 327 0863',
      showGbcaBadge: true,
    },

    integrations,

    credentialTypes: CREDENTIAL_TYPES.map((type) => ({
      type,
      label: CREDENTIAL_TYPE_LABELS[type],
      // F53 — Matt asked for a reminder a month out, per type.
      reminderLeadDays: 30,
      requiredForDrivers: type !== 'crane-ticket-class-4',
    })),
  };
}

let current: Settings | null = null;

function settings(): Settings {
  current ??= defaults();
  return current;
}

export function createMockSettingsService(): SettingsService {
  return {
    async get() {
      await latency(360, 180);
      return structuredClone(settings());
    },

    async saveGeneral(input) {
      await latency(620, 280);
      if (input.slaBusinessDays < 1 || input.slaBusinessDays > 30) {
        throw new ServiceError('VALIDATION_FAILED', 'SLA out of range', {
          fieldErrors: { slaBusinessDays: 'Enter between 1 and 30 business days' },
        });
      }
      current = { ...settings(), general: { ...settings().general, ...input } };
      return structuredClone(current.general);
    },

    async saveNotifications(input) {
      await latency(620, 280);
      if (input.reminderLeadDays < 1 || input.reminderLeadDays > 7) {
        throw new ServiceError('VALIDATION_FAILED', 'Reminder lead time out of range', {
          fieldErrors: { reminderLeadDays: 'Enter between 1 and 7 days' },
        });
      }
      // A reminder with no channel enabled is a reminder nobody receives.
      const silent = input.rules.find((rule) => !rule.sms && !rule.email);
      if (silent) {
        throw new ServiceError('VALIDATION_FAILED', 'An event has no channel', {
          fieldErrors: { rules: 'Every enabled event needs at least SMS or email' },
        });
      }
      current = { ...settings(), notifications: input };
      return structuredClone(current.notifications);
    },

    async saveInvoicing(input) {
      await latency(620, 280);
      if (input.defaultPaymentTermsDays < 0 || input.defaultPaymentTermsDays > 90) {
        throw new ServiceError('VALIDATION_FAILED', 'Payment terms out of range', {
          fieldErrors: { defaultPaymentTermsDays: 'Enter between 0 and 90 days' },
        });
      }
      current = { ...settings(), invoicing: input };
      return structuredClone(current.invoicing);
    },

    async saveCredentialTypes(input) {
      await latency(560, 240);
      const bad = input.find((type) => type.reminderLeadDays < 1 || type.reminderLeadDays > 180);
      if (bad) {
        throw new ServiceError('VALIDATION_FAILED', 'Lead time out of range', {
          fieldErrors: { reminderLeadDays: 'Enter between 1 and 180 days' },
        });
      }
      current = { ...settings(), credentialTypes: input };
      return structuredClone(current.credentialTypes);
    },

    async testIntegration(id) {
      await latency(900, 400);
      const integration = settings().integrations.find((candidate) => candidate.id === id);
      if (!integration) throw new ServiceError('NOT_FOUND', `No integration ${id}`);

      // Maps has no key in this build, so the honest answer is "not configured"
      // rather than a fake success.
      if (integration.state === 'not-configured') {
        throw new ServiceError(
          'CONFLICT',
          'This integration has no credentials configured, so there is nothing to test',
        );
      }

      const updated: Integration = {
        ...integration,
        state: 'connected',
        lastSuccessAt: new Date().toISOString(),
        detail:
          integration.id === 'mistral-ocr' ? 'Test extraction succeeded.' : integration.detail,
      };

      current = {
        ...settings(),
        integrations: settings().integrations.map((candidate) =>
          candidate.id === id ? updated : candidate,
        ),
      };

      return structuredClone(updated);
    },
  };
}
