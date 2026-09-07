import type {
  AdditionalServiceSetting,
  Integration,
  IntegrationId,
  IntegrationState,
  RateCardId,
  Settings,
  Zone,
} from '@plastago/shared';
import type { ResolvedRate } from '../../src/domains/settings/settings.repository.js';

/**
 * An in-memory stand-in for the settings repository.
 *
 * ── Why a fake and not a mocked Mongo ─────────────────────────────────────
 * What is under test here is arithmetic and refusals — whether $0.16 × 823.41 m²
 * comes back as $131.75, and whether a sequence can be wound backwards. Neither
 * needs a database, and a test that spins one up measures Mongo's availability
 * rather than the rule.
 *
 * It records what it was ASKED as well as what it returned, because some of the
 * assertions are about the lookup the service performs — a quote that silently
 * priced against the wrong rate card would still return a plausible number.
 */

/** The three zones, verbatim (M6.3). Decimal strings, never numbers. */
const ZONE_RATES: Record<Zone, { serviceCharge: string; ratePerM2: string }> = {
  sydney: { serviceCharge: '220.00', ratePerM2: '0.16' },
  wollongong: { serviceCharge: '250.00', ratePerM2: '0.18' },
  newcastle: { serviceCharge: '250.00', ratePerM2: '0.20' },
};

const SERVICES: Record<string, AdditionalServiceSetting> = {
  'recycling-bags': {
    code: 'recycling-bags',
    label: 'Recycling bags',
    kind: 'fixed',
    value: '30.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  contamination: {
    code: 'contamination',
    label: 'Contamination charge',
    kind: 'fixed',
    value: '90.00',
    requiresApproval: true,
    driverRaisable: true,
    systemGenerated: false,
  },
  'fuel-levy-percent': {
    code: 'fuel-levy-percent',
    label: 'Fuel levy (10%)',
    kind: 'percentage',
    value: '10',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
};

export function createFakeSettingsRepository() {
  /** Which zones each card knows about. Narrowed by a test to force a fallback. */
  let cardsWithRates = new Set<RateCardId>([
    'clarendon-domaine',
    'wisdom',
    'tier-1',
    'tier-2',
    'tier-3',
    'tier-4',
    'default',
  ]);

  /** Zones that have no rate on any card at all — the "nothing configured" path. */
  let unpricedZones = new Set<Zone>();

  let settings: Settings = baseSettings();
  /** Runs are new in PlastaGo, so this starts at 1 rather than continuing anything. */
  let nextRunNumber = 1;
  let integrations = new Map<IntegrationId, Integration>([
    [
      'xero',
      {
        id: 'xero',
        name: 'Xero',
        purpose: 'Push invoices.',
        state: 'not-configured',
        lastSuccessAt: null,
        detail: null,
        caveat: null,
      },
    ],
  ]);

  const calls = {
    resolveRate: [] as Array<{ rateCardId: RateCardId; zone: Zone }>,
    findAdditionalService: [] as string[],
    savedGeneral: null as Settings['general'] | null,
    savedNotifications: null as Settings['notifications'] | null,
    savedInvoicing: null as Settings['invoicing'] | null,
    savedCredentialTypes: null as Settings['credentialTypes'] | null,
    integrationChecks: [] as Array<{
      id: IntegrationId;
      state: IntegrationState;
      detail: string | null;
    }>,
  };

  const repository = {
    async get(): Promise<Settings> {
      return Promise.resolve(settings);
    },

    async resolveRate(rateCardId: RateCardId, zone: Zone): Promise<ResolvedRate | null> {
      calls.resolveRate.push({ rateCardId, zone });

      if (unpricedZones.has(zone)) return Promise.resolve(null);

      // Mirrors the real fallback: an unknown card falls back to `default`.
      const resolved = cardsWithRates.has(rateCardId) ? rateCardId : 'default';
      if (!cardsWithRates.has(resolved)) return Promise.resolve(null);

      return Promise.resolve({
        rateCardId: resolved,
        label: `${resolved} rates`,
        zone,
        serviceCharge: ZONE_RATES[zone].serviceCharge,
        ratePerM2: ZONE_RATES[zone].ratePerM2,
      });
    },

    async findAdditionalService(code: string): Promise<AdditionalServiceSetting | null> {
      calls.findAdditionalService.push(code);
      return Promise.resolve(SERVICES[code] ?? null);
    },

    async saveGeneral(input: Settings['general']): Promise<void> {
      calls.savedGeneral = input;
      /*
       * Only `slaBusinessDays`, exactly as the real repository does. Merging the
       * whole input here would let a test pass that the live API fails — which
       * is how the sequences came to be silently dropped in the first place.
       */
      settings = {
        ...settings,
        general: { ...settings.general, slaBusinessDays: input.slaBusinessDays },
      };
      return Promise.resolve();
    },

    async saveNotifications(input: Settings['notifications']): Promise<void> {
      calls.savedNotifications = input;
      settings = { ...settings, notifications: input };
      return Promise.resolve();
    },

    async saveInvoicing(input: Settings['invoicing']): Promise<void> {
      calls.savedInvoicing = input;
      settings = { ...settings, invoicing: input };
      return Promise.resolve();
    },

    async saveCredentialTypes(input: Settings['credentialTypes']): Promise<void> {
      calls.savedCredentialTypes = input;
      settings = { ...settings, credentialTypes: input };
      return Promise.resolve();
    },

    /**
     * Mirrors the real allocator: hands back the CURRENT value and advances.
     *
     * Returning the number before the increment matters — off by one here is a
     * permanently skipped job or invoice number (M1.4).
     *
     * `nextRunNumber` is not on the `Settings` contract (no screen sets it), so
     * it is counted here rather than read off `general`.
     */
    async takeNextNumber(
      field: 'nextJobNumber' | 'nextInvoiceNumber' | 'nextRunNumber',
    ): Promise<number> {
      if (field === 'nextRunNumber') {
        const taken = nextRunNumber;
        nextRunNumber += 1;
        return Promise.resolve(taken);
      }

      const taken = settings.general[field];
      settings = {
        ...settings,
        general: { ...settings.general, [field]: taken + 1 },
      };
      return Promise.resolve(taken);
    },

    async findIntegration(id: IntegrationId): Promise<Integration | null> {
      return Promise.resolve(integrations.get(id) ?? null);
    },

    async recordIntegrationCheck(
      id: IntegrationId,
      result: { state: IntegrationState; detail: string | null },
    ): Promise<void> {
      calls.integrationChecks.push({ id, ...result });

      const existing = integrations.get(id);
      if (existing) {
        integrations.set(id, {
          ...existing,
          state: result.state,
          detail: result.detail,
          // Only stamped on success — the same rule the real repository applies.
          lastSuccessAt:
            result.state === 'connected' ? new Date().toISOString() : existing.lastSuccessAt,
        });
      }
      return Promise.resolve();
    },
  };

  return {
    repository,
    calls,

    /** Force a card to have no rates, so the `default` fallback is exercised. */
    removeRatesFor(...cards: RateCardId[]): void {
      cardsWithRates = new Set([...cardsWithRates].filter((card) => !cards.includes(card)));
    },

    /** Force a zone to be unpriced everywhere — the configuration-gap path. */
    unprice(zone: Zone): void {
      unpricedZones = new Set([...unpricedZones, zone]);
    },

    current(): Settings {
      return settings;
    },

    integration(id: IntegrationId): Integration | undefined {
      return integrations.get(id);
    },
  };
}

function baseSettings(): Settings {
  return {
    general: {
      slaBusinessDays: 5,
      timezone: 'Australia/Sydney',
      dataRegion: 'ap-southeast-2',
      retentionYears: 7,
      nextJobNumber: 61_300,
      nextInvoiceNumber: 104_100,
      zones: [
        { zone: 'sydney', serviceCharge: '220.00', ratePerM2: '0.16' },
        { zone: 'wollongong', serviceCharge: '250.00', ratePerM2: '0.18' },
        { zone: 'newcastle', serviceCharge: '250.00', ratePerM2: '0.20' },
      ],
    },
    notifications: {
      rules: [{ event: 'job-booked', sms: true, email: true, includePhotos: false }],
      reminderLeadDays: 2,
      reminderIncludeRescheduleLink: true,
      queueDigestEnabled: true,
      queueDigestHour: 7,
    },
    pricing: {
      rateCards: [],
      additionalServices: Object.values(SERVICES),
      assumedCostPerJob: '100.00',
    },
    invoicing: {
      templates: [],
      invoiceNumberPrefix: '',
      splitAdditionalCharges: true,
      defaultPaymentTermsDays: 7,
      footerText: '',
      bankBsb: '082-343',
      bankAccount: '45 327 0863',
      showGbcaBadge: true,
    },
    integrations: [],
    credentialTypes: [
      {
        type: 'drivers-licence',
        label: 'Driver’s licence',
        reminderLeadDays: 30,
        requiredForDrivers: true,
      },
    ],
  };
}
