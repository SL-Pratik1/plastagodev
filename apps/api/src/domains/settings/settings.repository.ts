import { ZONES } from '@plastago/shared';
import type {
  AdditionalServiceSetting,
  BrandId,
  CredentialType,
  CredentialTypeSetting,
  Integration,
  IntegrationId,
  IntegrationState,
  InvoiceTemplate,
  NotificationEvent,
  NotificationRule,
  RateCardId,
  RateCardSummary,
  Settings,
  Zone,
  ZoneRate,
} from '@plastago/shared';
import type { Types } from 'mongoose';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { AccountModel } from '../accounts/account.model.js';
import {
  AdditionalServiceModel,
  CredentialTypeModel,
  IntegrationModel,
  InvoiceTemplateModel,
  NotificationRuleModel,
  RateCardModel,
  SETTINGS_SINGLETON_ID,
  SettingsModel,
  ZoneRateModel,
} from './settings.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * Settings are read on almost every request that prices something, so the reads
 * here are deliberately shaped to be cheap: the pricing lookup fetches one zone
 * rate by a compound index rather than loading the whole settings tree.
 */

/** The scalars, before the lists are joined onto them. */
interface RawSettings {
  slaBusinessDays: number;
  nextJobNumber: number;
  nextInvoiceNumber: number;
  splitAdditionalCharges: boolean;
  defaultPaymentTermsDays: number;
  invoiceNumberPrefix: string;
  footerText: string;
  bankBsb: string;
  bankAccount: string;
  showGbcaBadge: boolean;
  reminderLeadDays: number;
  reminderIncludeRescheduleLink: boolean;
  queueDigestEnabled: boolean;
  queueDigestHour: number;
  assumedCostPerJob: Types.Decimal128;
}

interface RawRateCard {
  _id: RateCardId;
  label: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

interface RawZoneRate {
  rateCardId: RateCardId;
  zone: Zone;
  serviceCharge: Types.Decimal128;
  ratePerM2: Types.Decimal128;
}

/**
 * What pricing needs to quote one job, resolved for one account.
 *
 * A deliberately narrow shape: the pricing service must not be handed the whole
 * settings tree, because then every caller could reach past what it declared it
 * needed and the coupling would be invisible.
 */
export interface ResolvedRate {
  rateCardId: RateCardId;
  /**
   * The card's human name, for the quote header. Resolved here rather than by
   * the caller so a preview never has to show a slug to a customer.
   */
  label: string;
  zone: Zone;
  /** Charged once per job, regardless of size. */
  serviceCharge: string;
  /** Per square metre, at rate precision. */
  ratePerM2: string;
}

export const settingsRepository = {
  /**
   * The whole settings tree, for the settings screen.
   *
   * Everything is fetched in parallel: these are seven independent collections
   * and doing them in sequence would make one screen seven round trips deep.
   */
  async get(): Promise<Settings> {
    const [
      scalars,
      rateCards,
      zoneRates,
      additionalServices,
      rules,
      integrations,
      credentialTypes,
      templates,
      accountCounts,
    ] = await Promise.all([
      SettingsModel.findById(SETTINGS_SINGLETON_ID).lean<RawSettings>(),
      RateCardModel.find().sort({ _id: 1 }).lean<RawRateCard[]>(),
      ZoneRateModel.find().lean<RawZoneRate[]>(),
      AdditionalServiceModel.find().sort({ _id: 1 }).lean(),
      NotificationRuleModel.find().lean(),
      IntegrationModel.find().sort({ _id: 1 }).lean(),
      CredentialTypeModel.find().sort({ _id: 1 }).lean(),
      InvoiceTemplateModel.find().sort({ _id: 1 }).lean(),
      countAccountsPerRateCard(),
    ]);

    if (!scalars) {
      // Seeding is a deployment step, not a request-time fallback: inventing
      // defaults here would let a misconfigured environment price real jobs.
      throw new Error('Settings have not been seeded — run `npm run seed:settings`');
    }

    /** Zone rates grouped by their card, so each summary carries its own. */
    const ratesByCard = new Map<string, ZoneRate[]>();
    for (const rate of zoneRates) {
      const list = ratesByCard.get(rate.rateCardId) ?? [];
      list.push({
        zone: rate.zone,
        serviceCharge: fromDecimal128(rate.serviceCharge),
        ratePerM2: fromDecimal128(rate.ratePerM2),
      });
      ratesByCard.set(rate.rateCardId, list);
    }

    /*
     * Sorted into the declared zone order, not the order Mongo happened to
     * return. Without this the rate table's rows can reorder between two loads
     * of the same screen, which reads as data changing when nothing has.
     */
    for (const list of ratesByCard.values()) {
      list.sort((a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone));
    }

    return {
      general: {
        slaBusinessDays: scalars.slaBusinessDays,
        // Read-only facts, shown so nobody has to go and ask. Constants rather
        // than settings because changing either is a migration, not a toggle.
        timezone: 'Australia/Sydney',
        dataRegion: 'ap-southeast-2',
        retentionYears: 7,
        nextJobNumber: scalars.nextJobNumber,
        nextInvoiceNumber: scalars.nextInvoiceNumber,
        zones: ratesByCard.get('default') ?? [],
      },
      notifications: {
        rules: rules.map(
          (rule): NotificationRule => ({
            event: rule._id as NotificationEvent,
            sms: rule.sms,
            email: rule.email,
            includePhotos: rule.includePhotos,
          }),
        ),
        reminderLeadDays: scalars.reminderLeadDays,
        reminderIncludeRescheduleLink: scalars.reminderIncludeRescheduleLink,
        queueDigestEnabled: scalars.queueDigestEnabled,
        queueDigestHour: scalars.queueDigestHour,
      },
      pricing: {
        rateCards: rateCards.map(
          (card): RateCardSummary => ({
            id: card._id,
            label: card.label,
            accountCount: accountCounts.get(card._id) ?? 0,
            effectiveFrom: card.effectiveFrom.toISOString().slice(0, 10),
            // Open-ended is the normal case: a card applies until superseded.
            effectiveTo: card.effectiveTo ? card.effectiveTo.toISOString().slice(0, 10) : '',
            zones: ratesByCard.get(card._id) ?? [],
          }),
        ),
        additionalServices: additionalServices.map(
          (service): AdditionalServiceSetting => ({
            code: service._id as string,
            label: service.label,
            kind: service.kind,
            value: fromDecimal128(service.value),
            requiresApproval: service.requiresApproval,
            driverRaisable: service.driverRaisable,
            systemGenerated: service.systemGenerated,
          }),
        ),
        assumedCostPerJob: fromDecimal128(scalars.assumedCostPerJob),
      },
      invoicing: {
        templates: templates.map(
          (template): InvoiceTemplate => ({
            id: template._id as string,
            name: template.name,
            brandId: template.brandId as BrandId,
            showsWeight: template.showsWeight,
            assignedAccountCount: 0,
          }),
        ),
        invoiceNumberPrefix: scalars.invoiceNumberPrefix,
        splitAdditionalCharges: scalars.splitAdditionalCharges,
        defaultPaymentTermsDays: scalars.defaultPaymentTermsDays,
        footerText: scalars.footerText,
        bankBsb: scalars.bankBsb,
        bankAccount: scalars.bankAccount,
        showGbcaBadge: scalars.showGbcaBadge,
      },
      integrations: integrations.map(
        (integration): Integration => ({
          id: integration._id as IntegrationId,
          name: integration.name,
          purpose: integration.purpose,
          state: integration.state,
          lastSuccessAt: integration.lastSuccessAt
            ? integration.lastSuccessAt.toISOString()
            : null,
          detail: integration.detail ?? null,
          caveat: integration.caveat ?? null,
        }),
      ),
      credentialTypes: credentialTypes.map(
        (credential): CredentialTypeSetting => ({
          type: credential._id as CredentialType,
          label: credential.label,
          reminderLeadDays: credential.reminderLeadDays,
          requiredForDrivers: credential.requiredForDrivers,
        }),
      ),
    };
  },

  /**
   * The rate for one account in one zone — the hot path for every quote.
   *
   * One indexed read, not a settings-tree load. `card_zone_unique` covers it
   * exactly, so this stays a single-document fetch however many rate cards
   * exist.
   */
  async resolveRate(rateCardId: RateCardId, zone: Zone): Promise<ResolvedRate | null> {
    const rate = await ZoneRateModel.findOne({ rateCardId, zone }).lean<RawZoneRate>();

    /*
     * Falling back to the default card is deliberate and narrow: a card that
     * genuinely has no entry for a zone should still price rather than fail a
     * booking mid-form. It is logged by the service, because a card missing a
     * zone is a configuration gap somebody needs to close.
     */
    const resolved =
      rate ?? (await ZoneRateModel.findOne({ rateCardId: 'default', zone }).lean<RawZoneRate>());

    if (!resolved) return null;

    // A second `_id` read on a collection with a handful of rows. Cheap, and it
    // keeps the slug out of anything a customer sees.
    const card = await RateCardModel.findById(resolved.rateCardId).lean<{ label: string }>();

    return {
      rateCardId: resolved.rateCardId,
      label: card?.label ?? resolved.rateCardId,
      zone: resolved.zone,
      serviceCharge: fromDecimal128(resolved.serviceCharge),
      ratePerM2: fromDecimal128(resolved.ratePerM2),
    };
  },

  /** One additional service by code, for pricing a charge the driver raised. */
  async findAdditionalService(code: string): Promise<AdditionalServiceSetting | null> {
    const service = await AdditionalServiceModel.findById(code).lean();
    if (!service) return null;

    return {
      code: service._id as string,
      label: service.label,
      kind: service.kind,
      value: fromDecimal128(service.value),
      requiresApproval: service.requiresApproval,
      driverRaisable: service.driverRaisable,
      systemGenerated: service.systemGenerated,
    };
  },

  /**
   * Take the next number in a sequence, atomically.
   *
   * ⚠️ `findOneAndUpdate($inc)` — one round trip that both reads and reserves.
   * Reading then writing would hand the same job number to two simultaneous
   * bookings, and M1.4 is explicit that these continue from TransVirtual and
   * must never collide.
   */
  async takeNextNumber(
    field: 'nextJobNumber' | 'nextInvoiceNumber' | 'nextRunNumber',
  ): Promise<number> {
    const updated = await SettingsModel.findOneAndUpdate(
      { _id: SETTINGS_SINGLETON_ID },
      { $inc: { [field]: 1 } },
      // `before` so the caller gets the number it reserved rather than the one
      // after it — off-by-one here is a permanently skipped invoice number.
      { returnDocument: 'before', projection: { [field]: 1 } },
    ).lean<Record<string, number>>();

    const value = updated?.[field];
    if (value === undefined) {
      throw new Error('Settings have not been seeded — run `npm run seed:settings`');
    }
    return value;
  },

  async saveGeneral(input: Settings['general']): Promise<void> {
    // Only the fields the office may actually change. `nextJobNumber` and the
    // read-only facts are deliberately NOT written from a form.
    await SettingsModel.updateOne(
      { _id: SETTINGS_SINGLETON_ID },
      { $set: { slaBusinessDays: input.slaBusinessDays } },
    );
  },

  async saveNotifications(input: Settings['notifications']): Promise<void> {
    await SettingsModel.updateOne(
      { _id: SETTINGS_SINGLETON_ID },
      {
        $set: {
          reminderLeadDays: input.reminderLeadDays,
          reminderIncludeRescheduleLink: input.reminderIncludeRescheduleLink,
          queueDigestEnabled: input.queueDigestEnabled,
          queueDigestHour: input.queueDigestHour,
        },
      },
    );

    // Upserted per rule rather than deleted-and-reinserted: a delete-all that
    // failed half way would leave the platform with no notification rules at
    // all, which fails silently — nobody gets told anything.
    await Promise.all(
      input.rules.map((rule) =>
        NotificationRuleModel.updateOne(
          { _id: rule.event },
          { $set: { sms: rule.sms, email: rule.email, includePhotos: rule.includePhotos } },
          { upsert: true },
        ),
      ),
    );
  },

  async saveInvoicing(input: Settings['invoicing']): Promise<void> {
    await SettingsModel.updateOne(
      { _id: SETTINGS_SINGLETON_ID },
      {
        $set: {
          invoiceNumberPrefix: input.invoiceNumberPrefix,
          splitAdditionalCharges: input.splitAdditionalCharges,
          defaultPaymentTermsDays: input.defaultPaymentTermsDays,
          footerText: input.footerText,
          bankBsb: input.bankBsb,
          bankAccount: input.bankAccount,
          showGbcaBadge: input.showGbcaBadge,
        },
      },
    );
  },

  async saveCredentialTypes(input: Settings['credentialTypes']): Promise<void> {
    await Promise.all(
      input.map((credential) =>
        CredentialTypeModel.updateOne(
          { _id: credential.type },
          {
            $set: {
              label: credential.label,
              reminderLeadDays: credential.reminderLeadDays,
              requiredForDrivers: credential.requiredForDrivers,
            },
          },
          { upsert: true },
        ),
      ),
    );
  },

  async findIntegration(id: IntegrationId): Promise<Integration | null> {
    const integration = await IntegrationModel.findById(id).lean();
    if (!integration) return null;

    return {
      id: integration._id as IntegrationId,
      name: integration.name,
      purpose: integration.purpose,
      state: integration.state,
      lastSuccessAt: integration.lastSuccessAt ? integration.lastSuccessAt.toISOString() : null,
      detail: integration.detail ?? null,
      caveat: integration.caveat ?? null,
    };
  },

  /** Records the outcome of a connectivity check (W7). Never touches secrets. */
  async recordIntegrationCheck(
    id: IntegrationId,
    result: { state: IntegrationState; detail: string | null },
  ): Promise<void> {
    await IntegrationModel.updateOne(
      { _id: id },
      {
        $set: {
          state: result.state,
          detail: result.detail,
          // Only stamped on success: a failed check must not make a broken
          // integration look like it worked a moment ago.
          ...(result.state === 'connected' ? { lastSuccessAt: new Date() } : {}),
        },
      },
    );
  },

  /** Seeds the platform. Idempotent, so it is safe to run on every deploy. */
  async seed(data: {
    rateCards: Array<{ id: RateCardId; label: string; effectiveFrom: Date }>;
    zoneRates: Array<{
      rateCardId: RateCardId;
      zone: Zone;
      serviceCharge: string;
      ratePerM2: string;
    }>;
    additionalServices: AdditionalServiceSetting[];
    notificationRules: NotificationRule[];
    integrations: Integration[];
    credentialTypes: CredentialTypeSetting[];
    invoiceTemplates: InvoiceTemplate[];
    assumedCostPerJob: string;
  }): Promise<void> {
    // `$setOnInsert` so re-running never resets a sequence that has already
    // issued numbers, or overwrites a setting the office has since changed.
    await SettingsModel.updateOne(
      { _id: SETTINGS_SINGLETON_ID },
      { $setOnInsert: { assumedCostPerJob: toDecimal128(data.assumedCostPerJob) } },
      { upsert: true },
    );

    await Promise.all([
      ...data.rateCards.map((card) =>
        RateCardModel.updateOne(
          { _id: card.id },
          { $set: { label: card.label, effectiveFrom: card.effectiveFrom } },
          { upsert: true },
        ),
      ),
      ...data.zoneRates.map((rate) =>
        ZoneRateModel.updateOne(
          { rateCardId: rate.rateCardId, zone: rate.zone },
          {
            $set: {
              serviceCharge: toDecimal128(rate.serviceCharge),
              ratePerM2: toDecimal128(rate.ratePerM2),
            },
          },
          { upsert: true },
        ),
      ),
      ...data.additionalServices.map((service) =>
        AdditionalServiceModel.updateOne(
          { _id: service.code },
          {
            $set: {
              label: service.label,
              kind: service.kind,
              value: toDecimal128(service.value),
              requiresApproval: service.requiresApproval,
              driverRaisable: service.driverRaisable,
              systemGenerated: service.systemGenerated,
            },
          },
          { upsert: true },
        ),
      ),
      ...data.notificationRules.map((rule) =>
        NotificationRuleModel.updateOne(
          { _id: rule.event },
          { $setOnInsert: { sms: rule.sms, email: rule.email, includePhotos: rule.includePhotos } },
          { upsert: true },
        ),
      ),
      ...data.integrations.map((integration) =>
        IntegrationModel.updateOne(
          { _id: integration.id },
          {
            $set: { name: integration.name, purpose: integration.purpose },
            $setOnInsert: { state: integration.state, caveat: integration.caveat },
          },
          { upsert: true },
        ),
      ),
      ...data.credentialTypes.map((credential) =>
        CredentialTypeModel.updateOne(
          { _id: credential.type },
          {
            $set: { label: credential.label },
            $setOnInsert: {
              reminderLeadDays: credential.reminderLeadDays,
              requiredForDrivers: credential.requiredForDrivers,
            },
          },
          { upsert: true },
        ),
      ),
      ...data.invoiceTemplates.map((template) =>
        InvoiceTemplateModel.updateOne(
          { _id: template.id },
          {
            $set: {
              name: template.name,
              brandId: template.brandId,
              showsWeight: template.showsWeight,
            },
          },
          { upsert: true },
        ),
      ),
    ]);
  },
};

/** How many accounts each rate card prices. One grouped query, not one per card. */
async function countAccountsPerRateCard(): Promise<Map<string, number>> {
  const rows = await AccountModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$rateCardId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}
