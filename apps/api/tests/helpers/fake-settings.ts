import { PROTECTED_SERVICE_CODES } from '@plastago/shared';
import type {
  AdditionalServiceCreate,
  AdditionalServiceSetting,
  AdditionalServiceUpdate,
  BrandId,
  InvoiceTemplateWrite,
  RateCardId,
  Settings,
  Zone,
  ZoneRateInput,
  ZoneSummary,
} from '@plastago/shared';
import type { ResolvedRate } from '../../src/domains/settings/settings.repository.js';

/**
 * A charge as it is STORED — no `deletable`, because that is computed on read
 * from the protected-code list. The fake mirrors the real split so a test
 * cannot accidentally assert a stored flag that does not exist.
 */
type StoredService = Omit<AdditionalServiceSetting, 'deletable'>;

/**
 * The date the fake's schedules open on.
 *
 * ⚠️ Deliberately far EARLIER than the real seed's `2026-04-01`, and that is
 * not an oversight.
 *
 * Effective dating means a job dated before every schedule prices nothing —
 * correct behaviour, and tested explicitly in `pricing.service.test.ts`. But
 * most suites here are about something else entirely (booking notices, PO
 * handling, job state) and their fixtures carry whatever ready date they were
 * written with. If the fake mirrored the seed's calendar, every one of those
 * would fail with "no rate configured" for a reason unrelated to what it
 * asserts — a fixture's date silently becoming part of its setup.
 *
 * So the fake prices any plausible date, and the tests that care about the
 * boundary move it themselves.
 */
const SEEDED_SCHEDULE_FROM = '2020-01-01';

/** The cards the fake starts with — the same seven the seed installs. */
const SEEDED_CARDS: readonly RateCardId[] = [
  'clarendon-domaine',
  'wisdom',
  'tier-1',
  'tier-2',
  'tier-3',
  'tier-4',
  'default',
];

/**
 * The zones every suite starts with (M6.3).
 *
 * ── Why the ids are literals ──────────────────────────────────────────────
 * Zones are documents now, so a fixture has to invent their ids. Hardcoded
 * 24-hex strings rather than `new ObjectId()` so a failure message names the
 * same zone every run and two suites can refer to the same one — the fake never
 * reaches Mongo, so nothing here has to be a real BSON id, only shaped like one.
 *
 * Array ORDER is `displayOrder`. Decimal strings, never numbers.
 */
interface FakeZone {
  id: string;
  slug: string;
  label: string;
  serviceCharge: string;
  ratePerM2: string;
}

export const SEED_ZONES: readonly FakeZone[] = [
  {
    id: '000000000000000000000001',
    slug: 'sydney',
    label: 'Sydney',
    serviceCharge: '220.00',
    ratePerM2: '0.16',
  },
  {
    id: '000000000000000000000002',
    slug: 'wollongong',
    label: 'Wollongong',
    serviceCharge: '250.00',
    ratePerM2: '0.18',
  },
  {
    id: '000000000000000000000003',
    slug: 'newcastle',
    label: 'Newcastle',
    serviceCharge: '250.00',
    ratePerM2: '0.20',
  },
];

/** Reach for a seeded zone by name, so a test reads as prose. */
export const ZONE = {
  sydney: SEED_ZONES[0]!.id,
  wollongong: SEED_ZONES[1]!.id,
  newcastle: SEED_ZONES[2]!.id,
} as const;

/**
 * The figures for a zone, with a fallback.
 *
 * ⚠️ A fallback, not a default. `noUncheckedIndexedAccess` makes the lookup
 * possibly-undefined, and a zone a test INVENTS — which is the entire point of
 * the zone-CRUD suite — has no entry here. Returning Sydney's figures keeps
 * those tests about the zone and not about arithmetic they never asserted.
 */
function ratesFor(zoneId: string): { serviceCharge: string; ratePerM2: string } {
  const zone = SEED_ZONES.find((candidate) => candidate.id === zoneId);
  return {
    serviceCharge: zone?.serviceCharge ?? SEED_ZONES[0]!.serviceCharge,
    ratePerM2: zone?.ratePerM2 ?? SEED_ZONES[0]!.ratePerM2,
  };
}

/** One rate row per seeded zone, as a settings tree carries them. */
function seededZoneRates() {
  return SEED_ZONES.map((zone) => ({
    zoneId: zone.id,
    zoneLabel: zone.label,
    serviceCharge: zone.serviceCharge,
    ratePerM2: zone.ratePerM2,
  }));
}

/** Apply the same `deletable` rule the real repository applies on read. */
function toContractService(service: StoredService): AdditionalServiceSetting {
  return {
    ...service,
    deletable: !(PROTECTED_SERVICE_CODES as readonly string[]).includes(service.code),
  };
}

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

const SEED_SERVICES: Record<string, StoredService> = {
  'recycling-bags': {
    code: 'recycling-bags',
    label: 'Recycling bags',
    kind: 'fixed',
    value: '30.00',
    requiresApproval: false,
    driverRaisable: false,
    systemGenerated: false,
  },
  // M6.5, Matt 07:37 — bags past the order's allowance. Mirrors the seeded
  // figure, and deliberately the same money as an ordered bag: what differs is
  // which invoice it is allowed to appear on.
  'extra-bags': {
    code: 'extra-bags',
    label: 'Extra bags (not on the original PO)',
    kind: 'fixed',
    value: '30.00',
    requiresApproval: true,
    driverRaisable: false,
    systemGenerated: true,
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
  // M4.6 — the driver-raised one that matters most commercially. Mirrors the
  // seeded figure so a test cannot pass against a price the system never uses.
  'futile-pickup': {
    code: 'futile-pickup',
    label: 'Futile pickup',
    kind: 'fixed',
    value: '120.00',
    requiresApproval: true,
    driverRaisable: true,
    systemGenerated: false,
  },
  // M6.6 — derived from the driver's own arrive/complete timestamps, which is
  // why it is `system` and why a driver cannot raise it by hand.
  'extra-load-time': {
    code: 'extra-load-time',
    label: 'Extra load time',
    kind: 'fixed',
    value: '100.00',
    requiresApproval: true,
    driverRaisable: false,
    systemGenerated: true,
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

  /** The zone register, as a test has left it. Mutable: zones are data now. */
  let zones: ZoneSummary[] = SEED_ZONES.map((zone, index) => ({
    id: zone.id,
    slug: zone.slug,
    label: zone.label,
    displayOrder: index,
    archived: false,
    placeCount: 0,
    accountCount: 0,
    jobCount: 0,
    archivable: true,
  }));

  /** Rate rows per zone, so a copy can be asserted rather than assumed. */
  const zoneRateRows = new Map<string, Array<{ rateCardId: RateCardId; effectiveFrom: string }>>();

  let settings: Settings = baseSettings();
  /**
   * M2.4a. Not on the `Settings` contract any more — the General tab is gone —
   * so the fake holds it the same way the real singleton does: a stored scalar
   * with no route that writes it.
   */
  let slaBusinessDays = 5;
  /*
   * The sequences, likewise off-contract (M1.4). They start where the client's
   * existing history leaves off, so a test asserting a job number is asserting
   * the real continuation rather than 1.
   *
   * `nextRunNumber` genuinely starts at 1: runs are new in PlastaGo and nobody
   * quotes them.
   */
  const sequences: Record<'nextJobNumber' | 'nextInvoiceNumber' | 'nextRunNumber', number> = {
    nextJobNumber: 61_300,
    nextInvoiceNumber: 104_100,
    nextRunNumber: 1,
  };
  /**
   * The schedules each card holds, as start dates.
   *
   * ⚠️ M6.2 — the fake models rate cards as VERSIONED, because that is the
   * property under test. A fake that kept one rate per card would let a test
   * about back-dating pass without exercising anything.
   */
  let schedulesByCard = new Map<RateCardId, string[]>(
    [...cardsWithRates].map((card) => [card, [SEEDED_SCHEDULE_FROM]]),
  );

  /** Cards that exist. Distinct from `cardsWithRates`: a card can have none. */
  let existingCards = new Set<RateCardId>([...cardsWithRates]);

  /** Set by a test to make the back-dating guard bite. */
  let earliestInvoiced = new Map<RateCardId, string>();

  /**
   * Per-schedule rate overrides, keyed `card:from:zone`.
   *
   * Only the schedules a test explicitly writes appear here; everything else
   * falls back to `ZONE_RATES`. That keeps the common case terse while letting
   * a versioning test prove that two schedules really do return different
   * money for the same card and zone.
   */
  const scheduledRates = new Map<string, { serviceCharge: string; ratePerM2: string }>();

  /** How many job charges carry a code — blocks deleting a used charge. */
  const chargeUsage = new Map<string, number>();

  /** How many accounts name each card — blocks deleting a referenced card. */
  const accountsPerCard = new Map<RateCardId, number>();

  /** How many accounts name each invoice template. Same guard, M7.5. */
  const accountsPerTemplate = new Map<string, number>();

  /**
   * This instance's charges, copied from the seed.
   *
   * ⚠️ A COPY, not the module constant. The create/update/delete methods
   * mutate this, and sharing one object across instances leaked state between
   * tests — a charge created in one `it` was still there in the next, so the
   * duplicate-code guard fired on a test that had never created anything. The
   * `beforeEach` that builds a new fake has to actually reset everything.
   */
  const services: Record<string, StoredService> = Object.fromEntries(
    Object.entries(SEED_SERVICES).map(([code, service]) => [code, { ...service }]),
  );

  /** The stored logo key, as `setLogoKey` last left it. */
  let logoKey = '';

  const calls = {
    resolveRate: [] as Array<{ rateCardId: RateCardId; zoneId: Zone; onDate: string }>,
    createdZones: [] as Array<{ slug: string; label: string; copyRatesFromZoneId: string }>,
    renamedZones: [] as Array<{ id: string; label: string }>,
    reorderedZones: [] as string[][],
    archivedZones: [] as Array<{ id: string; archived: boolean }>,
    findAdditionalService: [] as string[],
    savedInvoicing: null as Settings['invoicing'] | null,
    createdRateCards: [] as Array<{ id: RateCardId; effectiveFrom: string }>,
    issuedSchedules: [] as Array<{ id: RateCardId; effectiveFrom: string }>,
    deletedSchedules: [] as Array<{ id: RateCardId; effectiveFrom: string }>,
    logoKeys: [] as string[],
    deletedRateCards: [] as RateCardId[],
    createdServices: [] as AdditionalServiceCreate[],
    updatedServices: [] as Array<{ code: string; patch: AdditionalServiceUpdate }>,
    deletedServices: [] as string[],
    createdTemplates: [] as string[],
    updatedTemplates: [] as string[],
    deletedTemplates: [] as string[],
  };

  const repository = {
    async get(): Promise<Settings> {
      return Promise.resolve(settings);
    },

    async resolveRate(
      rateCardId: RateCardId,
      zoneId: Zone,
      onDate: string,
    ): Promise<ResolvedRate | null> {
      calls.resolveRate.push({ rateCardId, zoneId, onDate });

      if (unpricedZones.has(zoneId)) return Promise.resolve(null);

      // Mirrors the real fallback: a card with no rate for this zone falls back
      // to `default` — resolved ON THE SAME DATE, never on today.
      const resolved = cardsWithRates.has(rateCardId) ? rateCardId : 'default';
      if (!cardsWithRates.has(resolved)) return Promise.resolve(null);

      /*
       * The latest schedule whose start is on or before the date asked for.
       * A date before every schedule prices NOTHING, which is the real
       * behaviour: a back-dated job has no agreed rate to use.
       */
      const starts = [...(schedulesByCard.get(resolved) ?? [])].sort();
      const inForce = starts.filter((start) => start <= onDate).at(-1);
      if (inForce === undefined) return Promise.resolve(null);

      const override = scheduledRates.get(`${resolved}:${inForce}:${zoneId}`);
      const seeded = ratesFor(zoneId);

      return Promise.resolve({
        rateCardId: resolved,
        label: `${resolved} rates`,
        zoneId,
        zoneLabel: zones.find((zone) => zone.id === zoneId)?.label ?? 'Unknown zone',
        serviceCharge: override?.serviceCharge ?? seeded.serviceCharge,
        ratePerM2: override?.ratePerM2 ?? seeded.ratePerM2,
        scheduleFrom: inForce,
      });
    },

    /* ── Zones (M6.3) ────────────────────────────────────────────────────── */

    async allZones(): Promise<ZoneSummary[]> {
      return Promise.resolve(zones.map((zone) => ({ ...zone })));
    },

    async activeZones(): Promise<ZoneSummary[]> {
      return Promise.resolve(zones.filter((zone) => !zone.archived).map((zone) => ({ ...zone })));
    },

    /* ⚠️ Archived included, exactly like the real one. See the note there. */
    async findZone(id: string): Promise<ZoneSummary | null> {
      const zone = zones.find((candidate) => candidate.id === id);
      return Promise.resolve(zone ? { ...zone } : null);
    },

    async findZoneBySlug(slug: string): Promise<ZoneSummary | null> {
      const zone = zones.find((candidate) => candidate.slug === slug);
      return Promise.resolve(zone ? { ...zone } : null);
    },

    async findZoneLabel(id: string): Promise<string | null> {
      return Promise.resolve(zones.find((zone) => zone.id === id)?.label ?? null);
    },

    async activeZoneIds(): Promise<string[]> {
      return Promise.resolve(zones.filter((zone) => !zone.archived).map((zone) => zone.id));
    },

    async nextZoneDisplayOrder(): Promise<number> {
      return Promise.resolve(
        zones.reduce((highest, zone) => Math.max(highest, zone.displayOrder), -1) + 1,
      );
    },

    /**
     * ⚠️ This ACTUALLY COPIES the rate rows, across every remembered schedule.
     *
     * A fake that only recorded the call would let the real bug through — the
     * one where only the open schedule is copied, so a back-dated booking in the
     * new zone resolves nothing and 503s. The point of the fake here is that
     * `resolveRate(card, newZone, aDateInAClosedWindow)` answers correctly
     * afterwards, which it cannot do unless the copy really happened.
     */
    async createZoneCopyingRates(input: {
      slug: string;
      label: string;
      displayOrder: number;
      copyRatesFromZoneId: string;
    }): Promise<{ id: string; rowsCopied: number }> {
      calls.createdZones.push({
        slug: input.slug,
        label: input.label,
        copyRatesFromZoneId: input.copyRatesFromZoneId,
      });

      const id = `0000000000000000000000${String(zones.length + 1).padStart(2, '0')}`;

      zones = [
        ...zones,
        {
          id,
          slug: input.slug,
          label: input.label,
          displayOrder: input.displayOrder,
          archived: false,
          placeCount: 0,
          accountCount: 0,
          jobCount: 0,
          archivable: true,
        },
      ];

      // Every schedule the source zone has a row on, not just the open one.
      let rowsCopied = 0;
      for (const [key, rate] of [...scheduledRates.entries()]) {
        const [cardId, effectiveFrom, zoneId] = key.split(':');
        if (zoneId !== input.copyRatesFromZoneId) continue;

        scheduledRates.set(`${cardId ?? ''}:${effectiveFrom ?? ''}:${id}`, { ...rate });
        rowsCopied += 1;
      }

      /*
       * Plus the seeded schedule, which `baseSettings` writes without going
       * through `rememberRates` — so a zone created in a suite that never issued
       * a schedule of its own still prices.
       */
      for (const cardId of cardsWithRates) {
        const key = `${cardId}:${SEEDED_SCHEDULE_FROM}:${id}`;
        if (!scheduledRates.has(key)) {
          scheduledRates.set(key, ratesFor(input.copyRatesFromZoneId));
          rowsCopied += 1;
        }
      }

      zoneRateRows.set(
        id,
        [...cardsWithRates].map((rateCardId) => ({
          rateCardId,
          effectiveFrom: SEEDED_SCHEDULE_FROM,
        })),
      );

      return Promise.resolve({ id, rowsCopied });
    },

    async renameZone(id: string, label: string): Promise<void> {
      calls.renamedZones.push({ id, label });
      zones = zones.map((zone) => (zone.id === id ? { ...zone, label } : zone));
      return Promise.resolve();
    },

    async reorderZones(orderedIds: readonly string[]): Promise<void> {
      calls.reorderedZones.push([...orderedIds]);
      zones = zones.map((zone) => ({ ...zone, displayOrder: orderedIds.indexOf(zone.id) }));
      return Promise.resolve();
    },

    async setZoneArchived(id: string, archived: boolean): Promise<void> {
      calls.archivedZones.push({ id, archived });
      zones = zones.map((zone) =>
        zone.id === id ? { ...zone, archived, archivable: !archived } : zone,
      );
      return Promise.resolve();
    },

    async countActiveZones(): Promise<number> {
      return Promise.resolve(zones.filter((zone) => !zone.archived).length);
    },

    async countPlacesInZone(id: string): Promise<number> {
      return Promise.resolve(zones.find((zone) => zone.id === id)?.placeCount ?? 0);
    },

    async countAccountsInZone(id: string): Promise<number> {
      return Promise.resolve(zones.find((zone) => zone.id === id)?.accountCount ?? 0);
    },

    async countJobsInZone(id: string): Promise<number> {
      return Promise.resolve(zones.find((zone) => zone.id === id)?.jobCount ?? 0);
    },

    async countLeadsInZone(): Promise<number> {
      return Promise.resolve(0);
    },

    async findAdditionalService(code: string): Promise<AdditionalServiceSetting | null> {
      calls.findAdditionalService.push(code);
      const stored = services[code];
      return Promise.resolve(stored ? toContractService(stored) : null);
    },

    /* M2.4a — read-only, like the real one. There is no `saveGeneral` pair. */
    async slaBusinessDays(): Promise<number> {
      return Promise.resolve(slaBusinessDays);
    },

    async saveInvoicing(input: Settings['invoicing']): Promise<void> {
      calls.savedInvoicing = input;
      settings = { ...settings, invoicing: input };
      return Promise.resolve();
    },

    /**
     * Mirrors the real allocator: hands back the CURRENT value and advances.
     *
     * Returning the number before the increment matters — off by one here is a
     * permanently skipped job or invoice number (M1.4).
     */
    async takeNextNumber(
      field: 'nextJobNumber' | 'nextInvoiceNumber' | 'nextRunNumber',
    ): Promise<number> {
      const taken = sequences[field];
      sequences[field] = taken + 1;
      return Promise.resolve(taken);
    },

    /* ── Invoice templates (M7.5) ────────────────────────────────────────── */

    async findInvoiceTemplate(id: string): Promise<{ id: string; name: string } | null> {
      const found = settings.invoicing.templates.find((template) => template.id === id);
      return Promise.resolve(found ? { id: found.id, name: found.name } : null);
    },

    async countAccountsOnTemplate(id: string): Promise<number> {
      return Promise.resolve(accountsPerTemplate.get(id) ?? 0);
    },

    async createInvoiceTemplate(id: string, input: InvoiceTemplateWrite): Promise<void> {
      calls.createdTemplates.push(id);
      settings = {
        ...settings,
        invoicing: {
          ...settings.invoicing,
          templates: [
            ...settings.invoicing.templates,
            { id, ...input, assignedAccountCount: 0, deletable: true },
          ],
        },
      };
      return Promise.resolve();
    },

    async updateInvoiceTemplate(id: string, input: InvoiceTemplateWrite): Promise<void> {
      calls.updatedTemplates.push(id);
      settings = {
        ...settings,
        invoicing: {
          ...settings.invoicing,
          templates: settings.invoicing.templates.map((template) =>
            template.id === id ? { ...template, ...input } : template,
          ),
        },
      };
      return Promise.resolve();
    },

    async deleteInvoiceTemplate(id: string): Promise<void> {
      calls.deletedTemplates.push(id);
      settings = {
        ...settings,
        invoicing: {
          ...settings.invoicing,
          templates: settings.invoicing.templates.filter((template) => template.id !== id),
        },
      };
      return Promise.resolve();
    },

    /**
     * Mirrors the real resolution: the named template, else the brand's first,
     * else null. The fallback is the part worth modelling — an account with no
     * template chosen still has to render on the right letterhead.
     */
    async resolveTemplateFor(accountTemplateId: string | null, brandId: BrandId) {
      const templates = settings.invoicing.templates;

      const named =
        accountTemplateId === null
          ? undefined
          : templates.find((template) => template.id === accountTemplateId);

      return Promise.resolve(
        named ?? templates.find((template) => template.brandId === brandId) ?? null,
      );
    },

    /* ── Rate cards (M6.1, M6.2) ─────────────────────────────────────────── */

    async findRateCard(
      id: RateCardId,
    ): Promise<{ id: RateCardId; label: string; effectiveFrom: string } | null> {
      if (!existingCards.has(id)) return Promise.resolve(null);
      return Promise.resolve({ id, label: `${id} rates`, effectiveFrom: SEEDED_SCHEDULE_FROM });
    },

    async rateCardIds(): Promise<string[]> {
      return Promise.resolve([...existingCards]);
    },

    async countAccountsOnRateCard(id: RateCardId): Promise<number> {
      return Promise.resolve(accountsPerCard.get(id) ?? 0);
    },

    async scheduleStarts(id: RateCardId): Promise<string[]> {
      return Promise.resolve([...(schedulesByCard.get(id) ?? [])].sort());
    },

    async earliestInvoicedDateOnCard(id: RateCardId): Promise<string | null> {
      return Promise.resolve(earliestInvoiced.get(id) ?? null);
    },

    async countChargesWithCode(code: string): Promise<number> {
      return Promise.resolve(chargeUsage.get(code) ?? 0);
    },

    async createRateCard(input: {
      id: RateCardId;
      label: string;
      effectiveFrom: string;
      zones: readonly ZoneRateInput[];
    }): Promise<void> {
      calls.createdRateCards.push({ id: input.id, effectiveFrom: input.effectiveFrom });
      existingCards = new Set([...existingCards, input.id]);
      cardsWithRates = new Set([...cardsWithRates, input.id]);
      schedulesByCard = new Map(schedulesByCard).set(input.id, [input.effectiveFrom]);
      rememberRates(input.id, input.effectiveFrom, input.zones);
      settings = withCard(settings, input.id, input.label, input.effectiveFrom);
      return Promise.resolve();
    },

    async renameRateCard(id: RateCardId, label: string): Promise<void> {
      settings = {
        ...settings,
        pricing: {
          ...settings.pricing,
          rateCards: settings.pricing.rateCards.map((card) =>
            card.id === id ? { ...card, label } : card,
          ),
        },
      };
      return Promise.resolve();
    },

    async issueSchedule(
      id: RateCardId,
      effectiveFrom: string,
      zones: readonly ZoneRateInput[],
    ): Promise<void> {
      calls.issuedSchedules.push({ id, effectiveFrom });
      const starts = [...(schedulesByCard.get(id) ?? []), effectiveFrom].sort();
      schedulesByCard = new Map(schedulesByCard).set(id, starts);
      rememberRates(id, effectiveFrom, zones);
      settings = withSchedule(settings, id, effectiveFrom, zones);
      return Promise.resolve();
    },

    async deleteSchedule(id: RateCardId, effectiveFrom: string): Promise<boolean> {
      const starts = schedulesByCard.get(id) ?? [];
      if (!starts.includes(effectiveFrom)) return Promise.resolve(false);

      calls.deletedSchedules.push({ id, effectiveFrom });
      schedulesByCard = new Map(schedulesByCard).set(
        id,
        starts.filter((start) => start !== effectiveFrom),
      );
      return Promise.resolve(true);
    },

    async setLogoKey(key: string): Promise<void> {
      calls.logoKeys.push(key);
      logoKey = key;
      return Promise.resolve();
    },

    async logoKey(): Promise<string> {
      return Promise.resolve(logoKey);
    },

    async deleteRateCard(id: RateCardId): Promise<void> {
      calls.deletedRateCards.push(id);
      existingCards = new Set([...existingCards].filter((card) => card !== id));
      cardsWithRates = new Set([...cardsWithRates].filter((card) => card !== id));
      schedulesByCard = new Map([...schedulesByCard].filter(([card]) => card !== id));
      settings = {
        ...settings,
        pricing: {
          ...settings.pricing,
          rateCards: settings.pricing.rateCards.filter((card) => card.id !== id),
        },
      };
      return Promise.resolve();
    },

    /* ── Additional services (M6.5) ──────────────────────────────────────── */

    async createAdditionalService(input: AdditionalServiceCreate): Promise<void> {
      calls.createdServices.push(input);
      services[input.code] = {
        code: input.code,
        label: input.label,
        kind: input.kind,
        value: input.value,
        requiresApproval: input.requiresApproval,
        // Neither is settable from a request — mirrors the real repository.
        driverRaisable: false,
        systemGenerated: false,
      };
      settings = withServices(settings, services);
      return Promise.resolve();
    },

    async updateAdditionalService(code: string, patch: AdditionalServiceUpdate): Promise<void> {
      calls.updatedServices.push({ code, patch });
      const existing = services[code];
      if (existing) services[code] = { ...existing, ...patch };
      settings = withServices(settings, services);
      return Promise.resolve();
    },

    async deleteAdditionalService(code: string): Promise<void> {
      calls.deletedServices.push(code);
      delete services[code];
      settings = withServices(settings, services);
      return Promise.resolve();
    },
  };

  /** Remember a schedule's figures so `resolveRate` can return them by date. */
  function rememberRates(
    id: RateCardId,
    effectiveFrom: string,
    zones: readonly ZoneRateInput[],
  ): void {
    for (const zone of zones) {
      scheduledRates.set(`${id}:${effectiveFrom}:${zone.zoneId}`, {
        serviceCharge: zone.serviceCharge,
        ratePerM2: zone.ratePerM2,
      });
    }
  }

  return {
    repository,
    calls,

    /** Force a card to have no rates, so the `default` fallback is exercised. */
    removeRatesFor(...cards: RateCardId[]): void {
      cardsWithRates = new Set([...cardsWithRates].filter((card) => !cards.includes(card)));
    },

    /** The zone ids a suite may price against, in display order. */
    zoneIds(): string[] {
      return zones.filter((zone) => !zone.archived).map((zone) => zone.id);
    },

    /** What stands behind a zone, for the archive refusals. */
    putPlacesInZone(id: string, count: number): void {
      zones = zones.map((zone) => (zone.id === id ? { ...zone, placeCount: count } : zone));
    },

    putAccountsInZone(id: string, count: number): void {
      zones = zones.map((zone) => (zone.id === id ? { ...zone, accountCount: count } : zone));
    },

    putJobsInZone(id: string, count: number): void {
      zones = zones.map((zone) => (zone.id === id ? { ...zone, jobCount: count } : zone));
    },

    /** Retire a zone directly, without going through the service's refusals. */
    archiveZoneDirectly(id: string): void {
      zones = zones.map((zone) =>
        zone.id === id ? { ...zone, archived: true, archivable: false } : zone,
      );
    },

    /** Which cards ended up with a rate row for a zone — the copy, asserted. */
    rateRowsForZone(id: string): Array<{ rateCardId: RateCardId; effectiveFrom: string }> {
      return zoneRateRows.get(id) ?? [];
    },

    /** Force a zone to be unpriced everywhere — the configuration-gap path. */
    unprice(zone: Zone): void {
      unpricedZones = new Set([...unpricedZones, zone]);
    },

    current(): Settings {
      return settings;
    },

    /** Make the back-dating guard bite: this card has invoiced work from `date`. */
    invoicedFrom(card: RateCardId, date: string): void {
      earliestInvoiced = new Map(earliestInvoiced).set(card, date);
    },

    /** Put accounts on a card, so deleting it is refused. */
    /** Put accounts on a TEMPLATE, so the delete guard bites (M7.5). */
    assignTemplate(templateId: string, count: number): void {
      accountsPerTemplate.set(templateId, count);
    },

    assignAccounts(card: RateCardId, count: number): void {
      accountsPerCard.set(card, count);
      settings = {
        ...settings,
        pricing: {
          ...settings.pricing,
          rateCards: settings.pricing.rateCards.map((existing) =>
            existing.id === card
              ? { ...existing, accountCount: count, deletable: card !== 'default' && count === 0 }
              : existing,
          ),
        },
      };
    },

    /** Say a charge is already on `count` jobs, so deleting it is refused. */
    chargeUsedOn(code: string, count: number): void {
      chargeUsage.set(code, count);
    },

    /** Remove a card entirely, so `findRateCard` returns null for it. */
    removeCard(card: RateCardId): void {
      existingCards = new Set([...existingCards].filter((id) => id !== card));
    },
  };
}

/** A card added to the settings tree by a create. */
function withCard(
  settings: Settings,
  id: RateCardId,
  label: string,
  effectiveFrom: string,
): Settings {
  return {
    ...settings,
    pricing: {
      ...settings.pricing,
      rateCards: [
        ...settings.pricing.rateCards,
        {
          id,
          label,
          accountCount: 0,
          effectiveFrom,
          effectiveTo: '',
          zones: [],
          schedules: [{ effectiveFrom, effectiveTo: '', zones: [] }],
          deletable: true,
        },
      ],
    },
  };
}

/**
 * A schedule inserted into a card's history, with every window re-bounded.
 *
 * ── Why this recomputes the whole list rather than closing "the open one" ──
 * Because a schedule can be inserted BEFORE an existing one — back-dating a
 * rate that was keyed wrong is legitimate while nothing has been invoiced.
 * A fake that closed whatever was open and prepended the new row would report
 * two open-ended schedules, which is a state the real `card_zone_open_unique`
 * index forbids outright.
 *
 * So the invariant is asserted here the same way the repository enforces it:
 * a schedule runs until the day before the next one starts, and only the last
 * is open-ended. That is what makes the boundary tests meaningful.
 */
function withSchedule(
  settings: Settings,
  id: RateCardId,
  effectiveFrom: string,
  zones: readonly ZoneRateInput[],
): Settings {
  return {
    ...settings,
    pricing: {
      ...settings.pricing,
      rateCards: settings.pricing.rateCards.map((card) => {
        if (card.id !== id) return card;

        // Ascending, so each schedule can see the one that follows it.
        const ordered = [
          ...card.schedules.map((schedule) => ({ ...schedule })),
          {
            effectiveFrom,
            effectiveTo: '',
            /* The read shape carries the zone's NAME; the write shape does not. */
            zones: zones.map((rate) => ({
              ...rate,
              zoneLabel:
                SEED_ZONES.find((zone) => zone.id === rate.zoneId)?.label ?? 'Unknown zone',
            })),
          },
        ].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

        const bounded = ordered.map((schedule, index) => {
          const next = ordered[index + 1];
          return {
            ...schedule,
            effectiveTo: next ? previousDay(next.effectiveFrom) : '',
          };
        });

        const today = todayIso();
        const current = bounded.find(
          (schedule) =>
            schedule.effectiveFrom <= today &&
            (schedule.effectiveTo === '' || schedule.effectiveTo >= today),
        );

        return {
          ...card,
          // The flattened "in force today" view, same rule the read applies.
          zones: current ? [...current.zones] : [],
          // Newest first, matching what the repository returns.
          schedules: [...bounded].reverse(),
        };
      }),
    },
  };
}

/** `YYYY-MM-DD` one day earlier. Dates only, so UTC arithmetic is exact. */
function previousDay(isoDate: string): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Today in Sydney, matching the rule the repository reads windows with. */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

/**
 * Re-project one instance's charges onto its settings tree.
 *
 * Takes the map rather than reading a module-level one: the charges are
 * per-instance so a create in one test cannot leak into the next.
 */
function withServices(settings: Settings, services: Record<string, StoredService>): Settings {
  return {
    ...settings,
    pricing: {
      ...settings.pricing,
      additionalServices: Object.values(services).map(toContractService),
    },
  };
}

function baseSettings(): Settings {
  return {
    pricing: {
      zones: SEED_ZONES.map((zone, index) => ({
        id: zone.id,
        slug: zone.slug,
        label: zone.label,
        displayOrder: index,
        archived: false,
        placeCount: 0,
        accountCount: 0,
        jobCount: 0,
        archivable: true,
      })),
      /*
       * The seeded cards, each with one open schedule from `2026-04-01`.
       *
       * Populated rather than left empty because the guards under test read
       * `accountCount` and `deletable` off these rows — an empty list would
       * make every delete test pass by finding nothing.
       */
      rateCards: [...SEEDED_CARDS].map((id) => ({
        id,
        label: `${id} rates`,
        accountCount: 0,
        effectiveFrom: SEEDED_SCHEDULE_FROM,
        effectiveTo: '',
        zones: seededZoneRates(),
        schedules: [
          {
            effectiveFrom: SEEDED_SCHEDULE_FROM,
            effectiveTo: '',
            zones: seededZoneRates(),
          },
        ],
        // `default` is never deletable — `resolveRate` falls back to it.
        deletable: id !== 'default',
      })),
      additionalServices: Object.values(SEED_SERVICES).map(toContractService),
      assumedCostPerJob: '100.00',
    },
    invoicing: {
      /*
       * One template, not none (M7.5).
       *
       * An empty list would make every render test fail on "no template
       * configured" rather than on what it is asserting — and it would let a
       * regression in template RESOLUTION pass, because there would be
       * nothing to resolve.
       */
      templates: [
        {
          id: 'pg-m2',
          name: 'PlastaGo Recycling Invoice (m²)',
          brandId: 'plastago',
          showsWeight: false,
          layout: 'standard',
          accentColour: '#1a4d3a',
          assignedAccountCount: 0,
          deletable: true,
        },
      ],
      invoiceNumberPrefix: '',
      splitAdditionalCharges: true,
      defaultPaymentTermsDays: 7,
      logoKey: '',
      companyName: 'PlastaGo Pty Ltd',
      companyAbn: '51824753556',
      companyAddress: '1 Recycling Way, Smithfield NSW 2164',
      companyPhone: '02 9000 0000',
      companyEmail: 'accounts@plastago.com.au',
      termsText: 'Payment due within 7 days.',
      footerText: '',
      bankBsb: '082-343',
      bankAccount: '45 327 0863',
      bankAccountName: 'PlastaGo Pty Ltd',
      showGbcaBadge: true,
      certificateSignatureName: 'Matt Ryan',
      certificateSignatureTitle: 'Director',
      certificateSignatureKey: '',
      /*
       * Derived on read from `logoKey`, so the fake states it directly. Null is
       * the honest default: no logo has been uploaded in a test.
       */
      logoUrl: null,
      /** The same, for the certificate signature image (M9.5). */
      certificateSignatureUrl: null,
    },
  };
}
