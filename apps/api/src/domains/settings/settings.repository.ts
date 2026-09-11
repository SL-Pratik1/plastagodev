import { DEFAULT_RATE_CARD_ID, PROTECTED_SERVICE_CODES, ZONES } from '@plastago/shared';
import type {
  AdditionalServiceCreate,
  AdditionalServiceSetting,
  AdditionalServiceUpdate,
  BrandId,
  InvoiceTemplate,
  InvoiceTemplateWrite,
  RateCardId,
  RateCardSummary,
  RateSchedule,
  Settings,
  Zone,
  ZoneRateInput,
} from '@plastago/shared';
import type { Types } from 'mongoose';
import { startOfSydneyDay, todayInSydney } from '../../lib/business-day.js';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { AccountModel } from '../accounts/account.model.js';
/*
 * Two collections from other domains are READ here, never written.
 *
 * That is the same latitude `AccountModel` above already takes for the
 * accounts-per-card count, and the alternative is worse: routing "has this card
 * invoiced anything?" through the jobs service would make the settings domain
 * depend on a service that depends back on this repository for pricing.
 */
import { JobChargeModel, JobModel } from '../jobs/job.model.js';
import {
  AdditionalServiceModel,
  InvoiceTemplateModel,
  RateCardModel,
  SEQUENCE_STARTS,
  SETTINGS_SINGLETON_ID,
  SettingsModel,
  ZoneRateModel,
} from './settings.model.js';
import type { SequenceField } from './settings.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * Settings are read on almost every request that prices something, so the reads
 * here are deliberately shaped to be cheap: the pricing lookup fetches one zone
 * rate by a compound index rather than loading the whole settings tree.
 */

/**
 * The scalars, before the lists are joined onto them.
 *
 * ── Why the presentation fields are optional here ────────────────────────
 * ⚠️ This describes what `.lean()` actually RETURNS, not what the Mongoose
 * schema declares. A lean read hands back the stored document verbatim:
 * Mongoose applies a `default` when a document is created, never when a read
 * finds a path missing.
 *
 * So every field added to the settings singleton after it was first written is
 * genuinely `undefined` until something writes it. Typing them as `string`
 * was a lie that TypeScript then had no reason to question — and it is what
 * let `undefined` reach the contract and take the settings screen down.
 *
 * The required ones below are safe because they were present from the first
 * seed and `seed:settings` writes them.
 */
interface RawSettings {
  slaBusinessDays: number;
  nextJobNumber: number;
  nextInvoiceNumber: number;
  splitAdditionalCharges: boolean;
  defaultPaymentTermsDays: number;
  assumedCostPerJob: Types.Decimal128;

  /* Added after the first release — absent on an unmigrated document. */
  invoiceNumberPrefix?: string;
  footerText?: string;
  bankBsb?: string;
  bankAccount?: string;
  logoKey?: string;
  companyName?: string;
  companyAbn?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  termsText?: string;
  bankAccountName?: string;
  showGbcaBadge?: boolean;
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
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/** `YYYY-MM-DD` from a stored date, read in Sydney rather than UTC. */
function isoDay(value: Date): string {
  return todayInSydney(value);
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
  /**
   * Which schedule produced these figures (M6.2).
   *
   * Carried through to the job's frozen snapshot so "why was this $416?" is
   * answerable against a dated decision rather than against whatever the rate
   * tables happen to say when somebody asks.
   */
  scheduleFrom: string;
}

export const settingsRepository = {
  /**
   * The whole settings tree, for the settings screen.
   *
   * Everything is fetched in parallel: these are independent collections and
   * doing them in sequence would make one screen several round trips deep.
   */
  async get(): Promise<Settings> {
    const [
      scalars,
      rateCards,
      zoneRates,
      additionalServices,
      templates,
      accountCounts,
      templateCounts,
    ] =
      await Promise.all([
        SettingsModel.findById(SETTINGS_SINGLETON_ID).lean<RawSettings>(),
        RateCardModel.find().sort({ _id: 1 }).lean<RawRateCard[]>(),
        ZoneRateModel.find().lean<RawZoneRate[]>(),
        AdditionalServiceModel.find().sort({ _id: 1 }).lean(),
        InvoiceTemplateModel.find().sort({ _id: 1 }).lean(),
        countAccountsPerRateCard(),
        countAccountsPerTemplate(),
      ]);

    if (!scalars) {
      // Seeding is a deployment step, not a request-time fallback: inventing
      // defaults here would let a misconfigured environment price real jobs.
      throw new Error('Settings have not been seeded — run `npm run seed:settings`');
    }

    /*
     * Rates grouped first by card, then by the date their schedule starts.
     *
     * Two levels rather than one because a card now has a HISTORY: the screen
     * shows the schedule in force today at the top and the superseded ones
     * underneath, and both come out of this one query rather than one query per
     * card.
     */
    const schedulesByCard = new Map<string, Map<string, RateSchedule>>();
    for (const rate of zoneRates) {
      const byDate = schedulesByCard.get(rate.rateCardId) ?? new Map<string, RateSchedule>();
      const from = isoDay(rate.effectiveFrom);

      const schedule = byDate.get(from) ?? {
        effectiveFrom: from,
        // Open-ended is the normal case: a schedule applies until superseded.
        effectiveTo: rate.effectiveTo ? isoDay(rate.effectiveTo) : '',
        zones: [],
      };
      schedule.zones.push({
        zone: rate.zone,
        serviceCharge: fromDecimal128(rate.serviceCharge),
        ratePerM2: fromDecimal128(rate.ratePerM2),
      });

      byDate.set(from, schedule);
      schedulesByCard.set(rate.rateCardId, byDate);
    }

    const today = todayInSydney();

    return {
      pricing: {
        rateCards: rateCards.map((card): RateCardSummary => {
          const schedules = [...(schedulesByCard.get(card._id)?.values() ?? [])]
            /*
             * Zones sorted into the DECLARED order, not the order Mongo happened
             * to return. Without this the rate table's rows reorder between two
             * loads of the same screen, which reads as data changing when
             * nothing has.
             */
            .map((schedule) => ({
              ...schedule,
              zones: [...schedule.zones].sort(
                (a, b) => ZONES.indexOf(a.zone) - ZONES.indexOf(b.zone),
              ),
            }))
            // Newest first: the schedule somebody needs to see is the current
            // one, and history reads downwards from it.
            .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

          const current = schedules.find(
            (schedule) =>
              schedule.effectiveFrom <= today &&
              (schedule.effectiveTo === '' || schedule.effectiveTo >= today),
          );

          const accountCount = accountCounts.get(card._id) ?? 0;

          return {
            id: card._id,
            label: card.label,
            accountCount,
            effectiveFrom: isoDay(card.effectiveFrom),
            effectiveTo: card.effectiveTo ? isoDay(card.effectiveTo) : '',
            /*
             * The CURRENT schedule's zones, flattened. Empty where no schedule
             * covers today — a real state worth showing rather than papering
             * over: a card whose only schedule starts next month prices nothing
             * until then and falls back to `default`.
             */
            zones: current?.zones ?? [],
            schedules,
            /*
             * `default` is never deletable — `resolveRate` falls back to it, so
             * removing it turns a priced job into a failed one. Neither is a
             * card an account names.
             */
            deletable: card._id !== DEFAULT_RATE_CARD_ID && accountCount === 0,
          };
        }),
        additionalServices: additionalServices.map(
          (service): AdditionalServiceSetting => toService(service),
        ),
        assumedCostPerJob: fromDecimal128(scalars.assumedCostPerJob),
      },
      invoicing: {
        templates: templates.map((template): InvoiceTemplate => {
          const id = template._id as string;
          const assignedAccountCount = templateCounts.get(id) ?? 0;

          return {
            id,
            name: template.name,
            brandId: template.brandId as BrandId,
            showsWeight: template.showsWeight,
            /*
             * ⚠️ Coalesced, because `.lean()` does NOT apply schema defaults.
             *
             * Mongoose fills a default when a DOCUMENT is created, not when a
             * lean read finds the path missing. So a template row written
             * before `layout` and `accentColour` existed comes back without
             * them, `undefined` reaches the contract, and `SettingsSchema`
             * refuses the whole payload — which is what put "Something went
             * wrong" on the settings screen rather than a missing colour swatch.
             *
             * The migration backfills these; this makes the screen work
             * whether or not it has run yet.
             */
            layout: template.layout ?? 'standard',
            accentColour: template.accentColour ?? '#1a4d3a',
            /*
             * A real count now, not the hardcoded `0` this used to return.
             * The screen shows it, and the delete guard is derived from it —
             * a stub would have offered a delete that strands accounts.
             */
            assignedAccountCount,
            deletable: assignedAccountCount === 0,
          };
        }),
        invoiceNumberPrefix: scalars.invoiceNumberPrefix ?? '',
        splitAdditionalCharges: scalars.splitAdditionalCharges,
        defaultPaymentTermsDays: scalars.defaultPaymentTermsDays,
        /*
         * ⚠️ Every optional presentation field is coalesced, for the same
         * reason as `layout` above: `.lean()` returns the stored document, and
         * a settings singleton written before these fields existed simply does
         * not have them. `undefined` reaching `z.string()` fails the contract
         * and takes the whole screen down.
         *
         * Empty string is also the RIGHT answer, not just a safe one — the
         * renderer omits an empty field from the page rather than printing a
         * placeholder, so an unmigrated database produces a plainer invoice
         * instead of a broken one.
         */
        logoKey: scalars.logoKey ?? '',
        companyName: scalars.companyName ?? '',
        companyAbn: scalars.companyAbn ?? '',
        companyAddress: scalars.companyAddress ?? '',
        companyPhone: scalars.companyPhone ?? '',
        companyEmail: scalars.companyEmail ?? '',
        termsText: scalars.termsText ?? '',
        footerText: scalars.footerText ?? '',
        bankBsb: scalars.bankBsb ?? '',
        bankAccount: scalars.bankAccount ?? '',
        bankAccountName: scalars.bankAccountName ?? '',
        showGbcaBadge: scalars.showGbcaBadge ?? false,
      },
    };
  },

  /**
   * The rate for one account in one zone ON ONE DATE — the hot path for every
   * quote (M6.2).
   *
   * ⚠️ `onDate` is not optional and must not be defaulted to today by callers
   * who "only want current prices". Pricing a job reads the rates in force on
   * THAT JOB'S date: a pickup booked in September for an October ready date is
   * priced on October's schedule, and a March invoice reissued in June has to
   * come back with March's figures. Defaulting to today is precisely the bug
   * effective dating exists to prevent.
   *
   * One indexed read per card, covered by `card_zone_resolve`, so this stays a
   * two-document fetch however many schedules accumulate.
   */
  async resolveRate(
    rateCardId: RateCardId,
    zone: Zone,
    onDate: string,
  ): Promise<ResolvedRate | null> {
    const rate = await findRateOn(rateCardId, zone, onDate);

    /*
     * Falling back to the default card is deliberate and narrow: a card that
     * genuinely has no entry for a zone should still price rather than fail a
     * booking mid-form. It is logged by the service, because a card missing a
     * zone is a configuration gap somebody needs to close.
     *
     * ⚠️ The fallback is resolved on the SAME date, not on today. A card with no
     * October schedule must fall back to what `default` charged in October.
     */
    const resolved =
      rate ??
      (rateCardId === DEFAULT_RATE_CARD_ID
        ? null
        : await findRateOn(DEFAULT_RATE_CARD_ID, zone, onDate));

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
      scheduleFrom: isoDay(resolved.effectiveFrom),
    };
  },

  /** One additional service by code, for pricing a charge the driver raised. */
  async findAdditionalService(code: string): Promise<AdditionalServiceSetting | null> {
    const service = await AdditionalServiceModel.findById(code).lean();
    return service ? toService(service) : null;
  },

  /* ── Invoice templates (M7.5) ──────────────────────────────────────────── */

  async findInvoiceTemplate(id: string): Promise<{ id: string; name: string } | null> {
    const template = await InvoiceTemplateModel.findById(id).lean<{ _id: string; name: string }>();
    return template ? { id: template._id, name: template.name } : null;
  },

  async countAccountsOnTemplate(id: string): Promise<number> {
    return AccountModel.countDocuments({ invoiceTemplateId: id });
  },

  async createInvoiceTemplate(id: string, input: InvoiceTemplateWrite): Promise<void> {
    await InvoiceTemplateModel.create({ _id: id, ...input });
  },

  async updateInvoiceTemplate(id: string, input: InvoiceTemplateWrite): Promise<void> {
    await InvoiceTemplateModel.updateOne({ _id: id }, { $set: { ...input } });
  },

  async deleteInvoiceTemplate(id: string): Promise<void> {
    await InvoiceTemplateModel.deleteOne({ _id: id });
  },

  /**
   * The template an invoice should print on, resolved for one account.
   *
   * ── Why the fallback is by BRAND and not just "the first one" ────────────
   * An account with no template named still has to render, and rendering it on
   * whichever row sorted first would put an EasyLift invoice on PlastaGo
   * letterhead. Falling back within the brand keeps the letterhead right even
   * when nobody has chosen; only a brand with no templates at all returns null,
   * and that is a configuration gap the caller reports rather than papers over.
   */
  async resolveTemplateFor(
    accountTemplateId: string | null,
    brandId: BrandId,
  ): Promise<InvoiceTemplate | null> {
    const settings = await this.get();
    const templates = settings.invoicing.templates;

    const named =
      accountTemplateId === null
        ? undefined
        : templates.find((template) => template.id === accountTemplateId);

    return named ?? templates.find((template) => template.brandId === brandId) ?? null;
  },

  /* ── Rate cards (M6.1) ─────────────────────────────────────────────────── */

  async findRateCard(
    id: RateCardId,
  ): Promise<{ id: RateCardId; label: string; effectiveFrom: string } | null> {
    const card = await RateCardModel.findById(id).lean<RawRateCard>();
    if (!card) return null;
    return { id: card._id, label: card.label, effectiveFrom: isoDay(card.effectiveFrom) };
  },

  /** Every card id that exists, for validating an account's selection. */
  async rateCardIds(): Promise<string[]> {
    const cards = await RateCardModel.find().select({ _id: 1 }).lean<Array<{ _id: string }>>();
    return cards.map((card) => card._id);
  },

  /** How many accounts name this card. Blocks a delete that would orphan them. */
  async countAccountsOnRateCard(id: RateCardId): Promise<number> {
    return AccountModel.countDocuments({ rateCardId: id });
  },

  /**
   * The ready date of the EARLIEST job this card has invoiced, or null.
   *
   * ⚠️ The guard that stops a back-dated schedule disagreeing with a document
   * in a builder's accounts payable system. Read off the job's own frozen
   * snapshot rather than by joining through accounts, because an account may
   * have been moved to a different card since — the question is which jobs this
   * card actually PRICED, not which accounts point at it today.
   *
   * `not-invoiced` and `awaiting-po` are excluded: nothing has left the
   * building for those, so re-pricing them is a correction rather than a
   * contradiction.
   */
  async earliestInvoicedDateOnCard(id: RateCardId): Promise<string | null> {
    const earliest = await JobModel.findOne({
      'appliedRate.rateCardId': id,
      invoiceStatus: { $in: ['invoiced', 'paid'] },
    })
      .sort({ readyDate: 1 })
      .select({ readyDate: 1 })
      .lean<{ readyDate: string }>();

    return earliest?.readyDate ?? null;
  },

  /**
   * How many job charges carry this code.
   *
   * Blocks deleting a charge that is already on somebody's invoice — the row
   * would keep its code and lose its name, so a reprinted invoice would show a
   * slug where a description belongs.
   */
  async countChargesWithCode(code: string): Promise<number> {
    /*
     * Cast because `JobChargeModel.code` is typed as the enum of codes that
     * shipped, and the question here is about a code an administrator typed —
     * which is exactly the case where the answer is legitimately zero. Narrowing
     * the argument to the enum instead would make the guard unable to ask about
     * the codes it exists to protect.
     */
    return JobChargeModel.countDocuments({ code: code as never });
  },

  /**
   * The start dates of every schedule on a card, ascending.
   *
   * The service needs these to reject an overlapping or duplicate window, and
   * one small projected read beats loading the rate rows themselves.
   */
  async scheduleStarts(id: RateCardId): Promise<string[]> {
    const rows = await ZoneRateModel.find({ rateCardId: id })
      .select({ effectiveFrom: 1 })
      .lean<Array<{ effectiveFrom: Date }>>();

    const unique = new Set(rows.map((row) => isoDay(row.effectiveFrom)));
    return [...unique].sort();
  },

  /**
   * Create a card and its opening schedule as one unit.
   *
   * ⚠️ The card is written FIRST and the rates second, so a failure between the
   * two leaves a card with no schedule — which prices nothing and falls back to
   * `default` — rather than orphan rate rows pointing at a card that does not
   * exist. Of the two partial states that is the recoverable one: the
   * administrator sees the card and issues its schedule again.
   */
  async createRateCard(input: {
    id: RateCardId;
    label: string;
    effectiveFrom: string;
    zones: readonly ZoneRateInput[];
  }): Promise<void> {
    await RateCardModel.create({
      _id: input.id,
      label: input.label,
      effectiveFrom: startOfSydneyDay(input.effectiveFrom),
      effectiveTo: null,
    });

    await insertSchedule(input.id, input.effectiveFrom, input.zones);
  },

  async renameRateCard(id: RateCardId, label: string): Promise<void> {
    await RateCardModel.updateOne({ _id: id }, { $set: { label } });
  },

  /**
   * Issue a new schedule (M6.2) — the only way a rate ever changes.
   *
   * ── Why the previous schedule is closed rather than replaced ──────────────
   * The open row's window is narrowed to end the day before the new one starts,
   * and the new rows are inserted alongside it. Nothing that priced a job is
   * mutated, so a job priced last March still resolves to March's row and its
   * frozen snapshot still matches what the rate tables say.
   *
   * The close happens BEFORE the insert because `card_zone_open_unique` allows
   * only one open row per card and zone — doing it the other way round would
   * hit a duplicate key. That ordering also means a failure between the two
   * leaves the card with a closed schedule and no successor, which prices
   * nothing and falls back to `default`: visible, and safer than two rows both
   * claiming today.
   */
  async issueSchedule(
    id: RateCardId,
    effectiveFrom: string,
    zones: readonly ZoneRateInput[],
  ): Promise<void> {
    const from = startOfSydneyDay(effectiveFrom);
    /** The last instant of the day before — 23:59:59.999 in Sydney. */
    const endOfPreviousDay = new Date(from.getTime() - 1);

    /*
     * ⚠️ The new schedule may be going in BEFORE an existing one, not only
     * after it — back-dating a rate that was keyed wrong is a legitimate fix,
     * and the service allows it while nothing has been invoiced.
     *
     * So this cannot simply "close whatever is open and append". Doing that
     * left the later schedule open AND opened a second one, which
     * `card_zone_open_unique` rejects outright — the whole write would fail
     * with a duplicate-key error the caller cannot read. Found in QA by
     * reasoning through the index rather than by a test, because the in-memory
     * fake does not enforce indexes.
     *
     * The rule that holds in both directions: a schedule runs until the day
     * before the NEXT one starts, and only the last schedule is open-ended.
     */
    const next = await ZoneRateModel.findOne({ rateCardId: id, effectiveFrom: { $gt: from } })
      .sort({ effectiveFrom: 1 })
      .select({ effectiveFrom: 1 })
      .lean<{ effectiveFrom: Date }>();

    /*
     * Close the schedule that currently covers this date, if there is one.
     * Narrowed to rows starting BEFORE the new one so a later schedule is
     * never touched, and to open rows so an already-bounded window is not
     * silently re-cut.
     */
    await ZoneRateModel.updateMany(
      { rateCardId: id, effectiveTo: null, effectiveFrom: { $lt: from } },
      { $set: { effectiveTo: endOfPreviousDay } },
    );

    await insertSchedule(
      id,
      effectiveFrom,
      zones,
      // Open-ended only when nothing follows it. Otherwise bounded to the day
      // before the next schedule, so the windows tile with no gap or overlap.
      next ? new Date(next.effectiveFrom.getTime() - 1) : null,
    );
  },

  /**
   * Delete a card and every schedule under it.
   *
   * Only reachable once the service has established that no account names it
   * and it is not `default`. Jobs are unaffected: each carries its own frozen
   * rate snapshot, so an invoice reprinted after this still shows the figures it
   * was raised on.
   */
  async deleteRateCard(id: RateCardId): Promise<void> {
    await ZoneRateModel.deleteMany({ rateCardId: id });
    await RateCardModel.deleteOne({ _id: id });
  },

  /* ── Additional services (M6.5) ────────────────────────────────────────── */

  async createAdditionalService(input: AdditionalServiceCreate): Promise<void> {
    await AdditionalServiceModel.create({
      _id: input.code,
      label: input.label,
      kind: input.kind,
      value: toDecimal128(input.value),
      requiresApproval: input.requiresApproval,
      driverRaisable: input.driverRaisable,
      // Never settable from a request — see the note on the create schema.
      systemGenerated: false,
    });
  },

  async updateAdditionalService(code: string, input: AdditionalServiceUpdate): Promise<void> {
    await AdditionalServiceModel.updateOne(
      { _id: code },
      {
        $set: {
          label: input.label,
          value: toDecimal128(input.value),
          requiresApproval: input.requiresApproval,
          driverRaisable: input.driverRaisable,
        },
      },
    );
  },

  async deleteAdditionalService(code: string): Promise<void> {
    await AdditionalServiceModel.deleteOne({ _id: code });
  },

  /**
   * Take the next number in a sequence, atomically.
   *
   * ⚠️ One round trip that both reads and reserves. Reading then writing would
   * hand the same job number to two simultaneous bookings, and M1.4 is explicit
   * that these continue from TransVirtual and must never collide.
   *
   * ── Why this is a pipeline update and not a plain `$inc` ──────────────────
   * Because a plain `$inc` is wrong the first time a NEW sequence is added to a
   * settings document that already exists. `$inc` on a missing field creates it
   * at 1 and reports no previous value, so the caller both fails AND leaves the
   * sequence restarted at 1.
   *
   * Harmless for run numbers, which start at 1 anyway. Not harmless for
   * invoices: M1.4 says they continue from ~104,100 and must NEVER restart,
   * because three years of numbers are quoted in builders' AP systems. Found in
   * QA when `nextRunNumber` was added to an already-seeded document — the first
   * run creation after deploy returned a 500.
   *
   * `$ifNull` folds the seed default into the same atomic update, so a missing
   * field starts where it is supposed to and there is no window in which two
   * callers could both initialise it.
   */
  async takeNextNumber(field: SequenceField): Promise<number> {
    const start = SEQUENCE_STARTS[field];

    const updated = await SettingsModel.findOneAndUpdate(
      { _id: SETTINGS_SINGLETON_ID },
      [{ $set: { [field]: { $add: [{ $ifNull: [`$${field}`, start] }, 1] } } }],
      {
        // `before` so the caller gets the number it reserved rather than the one
        // after it — off-by-one here is a permanently skipped invoice number.
        returnDocument: 'before',
        projection: { [field]: 1 },
        // Mongoose 9 requires opting in before it will send an array as an
        // aggregation pipeline; without it the driver rejects the update.
        updatePipeline: true,
      },
    ).lean<Record<string, number>>();

    if (!updated) {
      // No settings document at all is a genuinely unseeded install, which is a
      // deployment problem rather than something a caller can recover from.
      throw new Error('Settings have not been seeded — run `npm run seed:settings`');
    }

    // Undefined here means the field was missing and the pipeline above has just
    // initialised it, so the number this caller reserved is the sequence's start.
    return updated[field] ?? start;
  },

  /**
   * M2.4a — the SLA, on its own.
   *
   * There is no `saveGeneral` counterpart: the settings screen no longer offers
   * the SLA, so this value changes by seed or migration only.
   *
   * A one-field read rather than `get()` because the three callers that price a
   * target date need this number and nothing else — handing a job service the
   * whole settings tree is how a domain quietly starts depending on the
   * invoice footer.
   */
  async slaBusinessDays(): Promise<number> {
    const scalars = await SettingsModel.findById(SETTINGS_SINGLETON_ID)
      .select({ slaBusinessDays: 1 })
      .lean<{ slaBusinessDays: number }>();

    if (!scalars) {
      // Same reasoning as `get()`: a default invented here would silently give
      // every job in a misconfigured environment the wrong promised date.
      throw new Error('Settings have not been seeded — run `npm run seed:settings`');
    }

    return scalars.slaBusinessDays;
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

  /** Seeds the platform. Idempotent, so it is safe to run on every deploy. */
  async seed(data: {
    rateCards: Array<{ id: RateCardId; label: string; effectiveFrom: Date }>;
    zoneRates: Array<{
      rateCardId: RateCardId;
      zone: Zone;
      serviceCharge: string;
      ratePerM2: string;
      /** Which schedule these figures open. `YYYY-MM-DD`. */
      effectiveFrom: string;
    }>;
    /*
     * `deletable` is omitted: it is COMPUTED on read from the protected-code
     * list, not stored. A seed that had to supply it would be asserting a
     * policy the read already owns, and the two would drift.
     */
    additionalServices: Array<Omit<AdditionalServiceSetting, 'deletable'>>;
    /*
     * `assignedAccountCount` and `deletable` are counted on read, so the seed
     * does not state them — the same split as `deletable` on a charge above.
     */
    invoiceTemplates: Array<Omit<InvoiceTemplate, 'assignedAccountCount' | 'deletable'>>;
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
      /*
       * Keyed on the START DATE as well as the card and zone, because a rate
       * row is a schedule VERSION now. Without `effectiveFrom` in the filter,
       * re-running the seed after an administrator had issued a new schedule
       * would upsert the seeded figures on top of the newest row and quietly
       * undo a price change.
       *
       * `$setOnInsert` on `effectiveTo` for the same reason: the seed opens a
       * schedule, and re-running must not reopen one that has since been closed.
       */
      ...data.zoneRates.map((rate) =>
        ZoneRateModel.updateOne(
          {
            rateCardId: rate.rateCardId,
            zone: rate.zone,
            effectiveFrom: startOfSydneyDay(rate.effectiveFrom),
          },
          {
            $set: {
              serviceCharge: toDecimal128(rate.serviceCharge),
              ratePerM2: toDecimal128(rate.ratePerM2),
            },
            $setOnInsert: { effectiveTo: null },
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
      ...data.invoiceTemplates.map((template) =>
        InvoiceTemplateModel.updateOne(
          { _id: template.id },
          {
            /*
             * ⚠️ `$setOnInsert`, not `$set`.
             *
             * Every one of these is editable on the settings screen, so
             * re-running the seed after an administrator renamed a template or
             * changed its accent colour must not quietly undo that. The seed
             * INSTALLS the five templates; it does not own them afterwards.
             */
            $setOnInsert: {
              name: template.name,
              brandId: template.brandId,
              showsWeight: template.showsWeight,
              layout: template.layout,
              accentColour: template.accentColour,
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

/**
 * How many accounts each invoice template is assigned to (M7.5).
 *
 * ⚠️ Accounts with a null `invoiceTemplateId` are EXCLUDED, not bucketed under
 * the brand default they will actually render with. The count exists to answer
 * "can this template be deleted?", and an account that merely falls back to a
 * template is not stranded when it disappears — one that names it is.
 */
async function countAccountsPerTemplate(): Promise<Map<string, number>> {
  const rows = await AccountModel.aggregate<{ _id: string | null; count: number }>([
    { $match: { invoiceTemplateId: { $ne: null } } },
    { $group: { _id: '$invoiceTemplateId', count: { $sum: 1 } } },
  ]);

  return new Map(
    rows.filter((row): row is { _id: string; count: number } => row._id !== null)
      .map((row) => [row._id, row.count]),
  );
}

/**
 * The one rate row whose window contains `onDate`.
 *
 * ── Why the query is written this way ─────────────────────────────────────
 * Both bounds are INCLUSIVE, and `effectiveTo: null` has to be treated as
 * "no upper bound" rather than as a comparable value — a plain `$gte` on a null
 * field matches nothing in Mongo, which would silently make every open-ended
 * schedule invisible and send every job to the `default` fallback.
 *
 * `$lte` on `effectiveFrom` against the START of the Sydney day means a job
 * dated exactly on a schedule's first day gets the new schedule, which is what
 * "effective from 1 October" means to the person who typed it.
 *
 * The sort is defensive: `card_zone_open_unique` already makes two matching
 * rows impossible, but if a migration ever left one behind, taking the latest
 * start is the same answer a human would give.
 */
async function findRateOn(
  rateCardId: RateCardId,
  zone: Zone,
  onDate: string,
): Promise<RawZoneRate | null> {
  const at = startOfSydneyDay(onDate);

  return ZoneRateModel.findOne({
    rateCardId,
    zone,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: at } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean<RawZoneRate>();
}

/**
 * The rows for one schedule.
 *
 * `effectiveTo` is a parameter rather than always `null` because a back-dated
 * schedule is bounded by the one that follows it — see the note in
 * `issueSchedule`. Only the newest schedule is genuinely open-ended.
 */
async function insertSchedule(
  rateCardId: RateCardId,
  effectiveFrom: string,
  zones: readonly ZoneRateInput[],
  effectiveTo: Date | null = null,
): Promise<void> {
  const from = startOfSydneyDay(effectiveFrom);

  await ZoneRateModel.insertMany(
    zones.map((rate) => ({
      rateCardId,
      zone: rate.zone,
      serviceCharge: toDecimal128(rate.serviceCharge),
      ratePerM2: toDecimal128(rate.ratePerM2),
      effectiveFrom: from,
      effectiveTo,
    })),
  );
}

/** One stored charge as the contract describes it. */
function toService(service: {
  _id: unknown;
  label: string;
  kind: 'fixed' | 'percentage';
  value: Types.Decimal128;
  requiresApproval: boolean;
  driverRaisable: boolean;
  systemGenerated: boolean;
}): AdditionalServiceSetting {
  const code = service._id as string;

  return {
    code,
    label: service.label,
    kind: service.kind,
    value: fromDecimal128(service.value),
    requiresApproval: service.requiresApproval,
    driverRaisable: service.driverRaisable,
    systemGenerated: service.systemGenerated,
    /*
     * The five codes the application looks up by literal name cannot be
     * removed — deleting one breaks a driver's workflow rather than shortening
     * a list. Their price and label remain fully editable.
     */
    deletable: !(PROTECTED_SERVICE_CODES as readonly string[]).includes(code),
  };
}
