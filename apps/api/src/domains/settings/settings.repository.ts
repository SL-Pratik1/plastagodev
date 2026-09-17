import { DEFAULT_RATE_CARD_ID, PROTECTED_SERVICE_CODES } from '@plastago/shared';
import type {
  InvoicingSettings,
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
  ZoneSummary,
} from '@plastago/shared';
import { Types } from 'mongoose';
import { startOfSydneyDay, todayInSydney } from '../../lib/business-day.js';
import { getStorage } from '../../integrations/storage.js';
import { fromDecimal128, toDecimal128 } from '../../lib/money.js';
import { withTransaction } from '../../lib/transaction.js';
import { AccountModel } from '../accounts/account.model.js';
import { PlaceModel } from '../places/place.model.js';
import { LeadModel } from '../queues/lead.model.js';
/*
 * Four collections from other domains are READ here, never written.
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
  ZoneModel,
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
  zoneId: Types.ObjectId;
  serviceCharge: Types.Decimal128;
  ratePerM2: Types.Decimal128;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

/**
 * Is this string shaped like an ObjectId at all?
 *
 * ⚠️ Guards every zone lookup that takes a value off the wire. `new
 * Types.ObjectId('sydney')` THROWS rather than returning null, so without this
 * a stale bookmark carrying the old slug would surface as a 500 instead of the
 * 404 it actually is.
 */
function isObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{24}$/.test(value);
}

/**
 * The zone register, with everything the settings screen shows about each one.
 *
 * ── Why the counts are here and not on the screen ─────────────────────────
 * `archivable` is COMPUTED on read, never stored — the same split as
 * `RateCardSummary.deletable`, and for the same reason: a UI that re-derived the
 * rule would offer a retire that comes back 409. The counts it is derived from
 * are returned too, so the screen can say WHY rather than just disabling a
 * button.
 *
 * ⚠️ Jobs and leads are counted but deliberately do NOT block archiving. Both
 * are history: a job carries its own frozen `appliedRate` and never reads the
 * zone table again. Guarding on them would mean a zone with any past work could
 * never be retired — which is every zone anybody would want to retire.
 */
async function zoneSummaries(filter: Record<string, unknown> = {}): Promise<ZoneSummary[]> {
  const zones = await ZoneModel.find(filter)
    .sort({ displayOrder: 1 })
    .lean<Array<{ _id: Types.ObjectId; slug: string; label: string; displayOrder: number; archived: boolean }>>();

  if (zones.length === 0) return [];

  const ids = zones.map((zone) => zone._id);

  /*
   * Three grouped counts rather than three-per-zone: a handful of zones today,
   * but the settings screen already makes seven parallel reads and this is not
   * the place to add N more.
   */
  const [places, accounts, jobs] = await Promise.all([
    PlaceModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { zoneId: { $in: ids }, archived: false } },
      { $group: { _id: '$zoneId', count: { $sum: 1 } } },
    ]),
    AccountModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { primaryZoneId: { $in: ids } } },
      { $group: { _id: '$primaryZoneId', count: { $sum: 1 } } },
    ]),
    JobModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { zoneId: { $in: ids } } },
      { $group: { _id: '$zoneId', count: { $sum: 1 } } },
    ]),
  ]);

  const tally = (rows: Array<{ _id: Types.ObjectId; count: number }>) =>
    new Map(rows.map((row) => [row._id.toString(), row.count]));

  const placeCounts = tally(places);
  const accountCounts = tally(accounts);
  const jobCounts = tally(jobs);

  return zones.map((zone) => {
    const id = zone._id.toString();
    const placeCount = placeCounts.get(id) ?? 0;
    const accountCount = accountCounts.get(id) ?? 0;

    return {
      id,
      slug: zone.slug,
      label: zone.label,
      displayOrder: zone.displayOrder,
      archived: zone.archived,
      placeCount,
      accountCount,
      jobCount: jobCounts.get(id) ?? 0,
      /*
       * Already archived reads as not-archivable, so the screen offers Restore
       * instead. The "last zone standing" rule is NOT re-derived here — it needs
       * a count across the whole collection, and the service refuses it with a
       * sentence that explains itself.
       */
      archivable: !zone.archived && placeCount === 0 && accountCount === 0,
    };
  });
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
  zoneId: Zone;
  /**
   * The zone's human name, for the charge-line description.
   *
   * ⚠️ Resolved HERE and then frozen by the caller onto the job. It is not a
   * live join: renaming a zone must never rewrite a description on an invoice
   * that has already been raised.
   */
  zoneLabel: string;
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
      zones,
      additionalServices,
      templates,
      accountCounts,
      templateCounts,
    ] = await Promise.all([
      SettingsModel.findById(SETTINGS_SINGLETON_ID).lean<RawSettings>(),
      RateCardModel.find().sort({ _id: 1 }).lean<RawRateCard[]>(),
      ZoneRateModel.find().lean<RawZoneRate[]>(),
      zoneSummaries(),
      AdditionalServiceModel.find().sort({ _id: 1 }).lean(),
      InvoiceTemplateModel.find().sort({ _id: 1 }).lean(),
      countAccountsPerRateCard(),
      countAccountsPerTemplate(),
    ]);

    /*
     * A settings document that does not exist yet — a brand-new install, before
     * the super-admin has configured anything.
     *
     * ── Why this no longer throws ────────────────────────────────────────
     * It used to, on the reasoning that inventing defaults would let a
     * misconfigured environment price real jobs. The instinct was right; the
     * blast radius was wrong. This is the read behind the SETTINGS SCREEN — the
     * one place the super-admin goes to fix exactly this — so throwing here
     * rendered a blank page with no explanation and no way forward. The first
     * thing a new operator does is the one thing that did not work.
     *
     * ⚠️ WHAT THIS DOES NOT RELAX: nothing here can price a job. Money comes
     * from `resolveRate`, which reads the rate-card collections and returns
     * null when they are empty, and the booking is refused with "no rate"
     * rather than priced at zero. The guard that matters is untouched.
     *
     * The screen knows it is looking at an unconfigured install from `rateCards`
     * being empty — no extra flag on the contract to keep in step.
     *
     * The numbers are the SCHEMA's own declared defaults, not new ones — the
     * same values Mongoose would write the moment the document is created, so
     * reading before the first save and reading after it agree.
     */
    const resolved: RawSettings = scalars ?? {
      slaBusinessDays: 5,
      nextJobNumber: SEQUENCE_STARTS.nextJobNumber,
      nextInvoiceNumber: SEQUENCE_STARTS.nextInvoiceNumber,
      splitAdditionalCharges: true,
      defaultPaymentTermsDays: 7,
      // No default in the schema either: a cost per job is a real figure
      // somebody has to supply, and zero reads as "not set yet" rather than
      // as a claim that jobs are free.
      assumedCostPerJob: toDecimal128('0'),
    };

    /*
     * Rates grouped first by card, then by the date their schedule starts.
     *
     * Two levels rather than one because a card now has a HISTORY: the screen
     * shows the schedule in force today at the top and the superseded ones
     * underneath, and both come out of this one query rather than one query per
     * card.
     */
    /*
     * Zone id → name and position, built once for the whole tree.
     *
     * ⚠️ Replaces `ZONES.indexOf`, which returned -1 for an unrecognised zone and
     * so sorted it to the TOP of every rate table. The fallback below sorts an
     * unknown zone LAST, which is what "I do not recognise this" should look
     * like.
     */
    const zoneNames = new Map(zones.map((zone) => [zone.id, zone.label]));
    const zoneOrder = new Map(zones.map((zone) => [zone.id, zone.displayOrder]));
    const orderOf = (id: string) => zoneOrder.get(id) ?? Number.MAX_SAFE_INTEGER;

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
        zoneId: rate.zoneId.toString(),
        /*
         * Named from the zone register rather than left as an id.
         *
         * A zone deleted out from under a rate row cannot happen — zones are
         * archived, never removed — so the fallback is for a database somebody
         * has edited by hand, and it says so rather than rendering a bare id.
         */
        zoneLabel: zoneNames.get(rate.zoneId.toString()) ?? 'Unknown zone',
        serviceCharge: fromDecimal128(rate.serviceCharge),
        ratePerM2: fromDecimal128(rate.ratePerM2),
      });

      byDate.set(from, schedule);
      schedulesByCard.set(rate.rateCardId, byDate);
    }

    const today = todayInSydney();

    return {
      pricing: {
        zones,
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
                (a, b) => orderOf(a.zoneId) - orderOf(b.zoneId),
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
        /*
         * ⚠️ `extra-load-time` is filtered OUT, deliberately.
         *
         * The charge is seeded and protected from deletion, and its price was
         * editable on this screen — but nothing in the application ever raises
         * it. The driver's on-site minutes are captured and stored, and they
         * feed one dashboard median; no code turns them into a charge. So the
         * control was an invitation to set a price for work that is never
         * billed, which is worse than the charge not appearing at all.
         *
         * Hidden rather than deleted, and hidden HERE rather than in the web
         * app, so no surface can show it. The document stays exactly as it is:
         * when the derivation is built, deleting these four lines is the whole
         * of putting the control back.
         */
        additionalServices: additionalServices
          .filter((service) => (service._id as string) !== UNBILLED_SERVICE_CODE)
          .map((service): AdditionalServiceSetting => toService(service)),
        assumedCostPerJob: fromDecimal128(resolved.assumedCostPerJob),
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
        invoiceNumberPrefix: resolved.invoiceNumberPrefix ?? '',
        splitAdditionalCharges: resolved.splitAdditionalCharges,
        defaultPaymentTermsDays: resolved.defaultPaymentTermsDays,
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
        logoKey: resolved.logoKey ?? '',
        companyName: resolved.companyName ?? '',
        companyAbn: resolved.companyAbn ?? '',
        companyAddress: resolved.companyAddress ?? '',
        companyPhone: resolved.companyPhone ?? '',
        companyEmail: resolved.companyEmail ?? '',
        termsText: resolved.termsText ?? '',
        footerText: resolved.footerText ?? '',
        bankBsb: resolved.bankBsb ?? '',
        bankAccount: resolved.bankAccount ?? '',
        bankAccountName: resolved.bankAccountName ?? '',
        showGbcaBadge: resolved.showGbcaBadge ?? false,
        /*
         * A link to the stored mark, so the screen can show what the invoices
         * actually print rather than the storage key, which tells a person
         * nothing. Derived on read and never written back — see the note on
         * `InvoicingSettingsReadSchema`.
         */
        logoUrl: await logoUrlFor(resolved.logoKey ?? ''),
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
    zoneId: Zone,
    onDate: string,
  ): Promise<ResolvedRate | null> {
    const rate = await findRateOn(rateCardId, zoneId, onDate);

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
        : await findRateOn(DEFAULT_RATE_CARD_ID, zoneId, onDate));

    if (!resolved) return null;

    // Two `_id` reads on collections with a handful of rows each. Cheap, and
    // they keep ids out of anything a customer sees.
    const [card, zone] = await Promise.all([
      RateCardModel.findById(resolved.rateCardId).lean<{ label: string }>(),
      ZoneModel.findById(resolved.zoneId).lean<{ label: string }>(),
    ]);

    return {
      rateCardId: resolved.rateCardId,
      label: card?.label ?? resolved.rateCardId,
      zoneId: resolved.zoneId.toString(),
      /*
       * ⚠️ The fallback is not cosmetic. This string is written into the
       * charge-line description and onto the invoice, so an id leaking here
       * would be printed and sent to a builder. A zone cannot actually vanish —
       * they are archived, never deleted — so this only fires on a database
       * edited by hand, and it says something a person can act on.
       */
      zoneLabel: zone?.label ?? 'Unknown zone',
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

  /* ── Zones (M6.3) ──────────────────────────────────────────────────────── */

  /** Every zone, archived included — historical records still need their names. */
  async allZones(): Promise<ZoneSummary[]> {
    return zoneSummaries();
  },

  /**
   * The zones a new booking or a new schedule may use.
   *
   * ⚠️ Archived zones are excluded HERE and nowhere else. This is what
   * `assertPricesEveryZone` counts against, so retiring a zone stops it blocking
   * every future rate change while its historical rows keep resolving.
   */
  async activeZones(): Promise<ZoneSummary[]> {
    return zoneSummaries({ archived: false });
  },

  /**
   * One zone by id, ARCHIVED INCLUDED.
   *
   * ⚠️ The inclusion is load-bearing, not incidental. This is the existence
   * check behind the slug-duplicate refusal, and a retired zone still owns rate
   * rows in `zonerates` — reissuing its slug would hand a brand-new zone prices
   * nobody set. Do not "tidy" this into an active-only lookup.
   */
  async findZone(id: string): Promise<ZoneSummary | null> {
    if (!isObjectId(id)) return null;
    const [zone] = await zoneSummaries({ _id: new Types.ObjectId(id) });
    return zone ?? null;
  },

  /**
   * Just the name.
   *
   * Exists because the "no rate configured" refusal has to NAME the zone and is
   * otherwise holding only an id — and `findZone` above runs three grouped
   * counts nobody needs in order to write an error message.
   */
  async findZoneLabel(id: string): Promise<string | null> {
    if (!isObjectId(id)) return null;
    const zone = await ZoneModel.findById(new Types.ObjectId(id), { label: 1 }).lean<{
      label: string;
    }>();
    return zone?.label ?? null;
  },

  /** By slug, for the seeds and for the duplicate check on create. */
  async findZoneBySlug(slug: string): Promise<ZoneSummary | null> {
    const [zone] = await zoneSummaries({ slug });
    return zone ?? null;
  },

  /** The live zone ids, for the existence guards that replaced `enum: ZONES`. */
  async activeZoneIds(): Promise<string[]> {
    const rows = await ZoneModel.find({ archived: false }, { _id: 1 }).lean<
      Array<{ _id: Types.ObjectId }>
    >();
    return rows.map((row) => row._id.toString());
  },

  /** One past the highest, so a new zone lands at the end of every list. */
  async nextZoneDisplayOrder(): Promise<number> {
    const last = await ZoneModel.findOne({}, { displayOrder: 1 })
      .sort({ displayOrder: -1 })
      .lean<{ displayOrder: number }>();
    return (last?.displayOrder ?? -1) + 1;
  },

  /**
   * A new zone, with every rate row copied from an existing one (M6.3).
   *
   * ── Why the rates are copied rather than typed ────────────────────────────
   * A zone with no rates prices nothing on any card, so every job in it falls
   * back to `default` — which has no rates for it either — and the booking is
   * refused with a 503 the office cannot act on. Asking an administrator to type
   * seven cards × N schedules of figures before the zone works is not a form
   * anybody completes correctly. So they nominate a zone to copy, and the
   * per-card discounts come with it: Clarendon's Sydney row becomes Clarendon's
   * new-zone row, Tier 4's becomes Tier 4's, and the commercial shape of the
   * price list survives.
   *
   * ── Why EVERY schedule and not just the open one ──────────────────────────
   * ⚠️ `resolveRate` reads the row whose window contains the JOB'S date, not
   * today's. Copying only the open row leaves every earlier date unpriced in the
   * new zone — so a back-dated booking, or an invoice reissued for March, fails
   * with "no rate is configured" on a zone the screen shows as fully priced.
   * Copying the whole history makes the new zone's windows tile the calendar
   * exactly as the source zone's do.
   *
   * ── Index safety ─────────────────────────────────────────────────────────
   * `card_zone_open_unique` holds because the SOURCE obeys it: at most one open
   * row per card, so at most one copy per card is open. `card_zone_from_unique`
   * holds because the zone id is brand new by construction — which is exactly
   * why the caller's duplicate check must see archived zones too.
   *
   * ── Parent first, and what `compensate` undoes ────────────────────────────
   * The zone is written BEFORE its rates, per the house rule in
   * `lib/transaction.ts`: on a standalone mongod a failure between the two
   * leaves a zone with no rates — visible on the settings screen and fixable —
   * rather than rate rows pointing at a zone nobody can see. The compensation
   * removes both, because a HALF-copied zone is the one state worse than
   * either: it would price correctly on some cards and 503 on others.
   *
   * ⚠️ `Decimal128` values are carried across verbatim, never through a string.
   * These figures must match TransVirtual to the cent (Risk 1), and `0.1625` is
   * a rate a round trip can round.
   */
  async createZoneCopyingRates(input: {
    slug: string;
    label: string;
    displayOrder: number;
    copyRatesFromZoneId: string;
  }): Promise<{ id: string; rowsCopied: number }> {
    const id = new Types.ObjectId();

    return withTransaction(
      async (session) => {
        await ZoneModel.create(
          [
            {
              _id: id,
              slug: input.slug,
              label: input.label,
              displayOrder: input.displayOrder,
              archived: false,
            },
          ],
          session ? { session } : {},
        );

        const source = await ZoneRateModel.find({
          zoneId: new Types.ObjectId(input.copyRatesFromZoneId),
        })
          .session(session ?? null)
          .lean<RawZoneRate[]>();

        if (source.length > 0) {
          await ZoneRateModel.insertMany(
            source.map((row) => ({
              rateCardId: row.rateCardId,
              zoneId: id,
              // Verbatim Decimal128 — see the warning above.
              serviceCharge: row.serviceCharge,
              ratePerM2: row.ratePerM2,
              // The window, unchanged. This is what makes the new zone's history
              // tile exactly as the source's does.
              effectiveFrom: row.effectiveFrom,
              effectiveTo: row.effectiveTo,
            })),
            session ? { session, ordered: true } : { ordered: true },
          );
        }

        return { id: id.toString(), rowsCopied: source.length };
      },
      {
        label: 'settings.createZone',
        compensate: async () => {
          await ZoneRateModel.deleteMany({ zoneId: id });
          await ZoneModel.deleteOne({ _id: id });
        },
      },
    );
  },

  async renameZone(id: string, label: string): Promise<void> {
    await ZoneModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: { label } });
  },

  /**
   * The whole list, renumbered 0..n.
   *
   * One `bulkWrite` rather than n updates: the intermediate states of a reorder
   * are not states anybody should be able to read, and `displayOrder` carries no
   * unique index precisely so this rewrite is representable.
   */
  async reorderZones(orderedIds: readonly string[]): Promise<void> {
    await ZoneModel.bulkWrite(
      orderedIds.map((id, index) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(id) },
          update: { $set: { displayOrder: index } },
        },
      })),
    );
  },

  async setZoneArchived(id: string, archived: boolean): Promise<void> {
    await ZoneModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: { archived } });
  },

  async countActiveZones(): Promise<number> {
    return ZoneModel.countDocuments({ archived: false });
  },

  /* What stands behind a zone. All four are read for the settings screen. */
  async countPlacesInZone(id: string): Promise<number> {
    return PlaceModel.countDocuments({ zoneId: new Types.ObjectId(id), archived: false });
  },

  async countAccountsInZone(id: string): Promise<number> {
    return AccountModel.countDocuments({ primaryZoneId: new Types.ObjectId(id) });
  },

  async countJobsInZone(id: string): Promise<number> {
    return JobModel.countDocuments({ zoneId: new Types.ObjectId(id) });
  },

  async countLeadsInZone(id: string): Promise<number> {
    return LeadModel.countDocuments({ zoneId: new Types.ObjectId(id) });
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
      /*
       * Neither of these is settable from a request.
       *
       * `systemGenerated` means "derived by code that exists" — see the note on
       * the create schema. `driverRaisable` is false because the driver app
       * decides what it offers from the screens it ships, never from this
       * column; a new charge therefore reaches no phone, which is the truth
       * rather than a default.
       */
      driverRaisable: false,
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
          // `driverRaisable` is deliberately absent — see the create above.
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

    const reserve = (): Promise<Record<string, number> | null> =>
      SettingsModel.findOneAndUpdate(
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

    let updated = await reserve();

    if (!updated) {
      /*
       * No settings document yet — a brand-new database, not a broken one.
       *
       * This used to refuse the booking and say to run `seed:settings`. That
       * script REFUSES to run with NODE_ENV=production, so on a fresh
       * production database the instruction could not be followed and the
       * first job anyone raised returned a 500. An install can create its own
       * singleton; it should not need a script to exist.
       *
       * ⚠️ A PLAIN update, deliberately — NOT the pipeline above. Mongoose
       * applies schema defaults on an upsert-insert only for a non-pipeline
       * update, so this writes a COMPLETE document: `slaBusinessDays`,
       * `defaultPaymentTermsDays`, `splitAdditionalCharges` and every sequence.
       * A pipeline upsert would write `_id` and this one sequence alone, and
       * `get()` would then hand `undefined` to fields its contract declares
       * required — which is what takes the settings screen down.
       *
       * `assumedCostPerJob` is stated because it has no schema default: a cost
       * per job is a real figure somebody supplies, and zero reads as "not set
       * yet" rather than as a claim that jobs are free. The same value `get()`
       * already falls back to.
       */
      try {
        await SettingsModel.updateOne(
          { _id: SETTINGS_SINGLETON_ID },
          { $setOnInsert: { assumedCostPerJob: toDecimal128('0') } },
          { upsert: true },
        );
      } catch (error) {
        /*
         * Two first bookings at once: both find no document, both insert, and
         * the loser gets a duplicate key on `_id`. The document it wanted now
         * exists, which is all this step was for, so the reserve below can
         * proceed. Anything else is a real failure and still throws.
         */
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 11000) throw error;
      }

      updated = await reserve();
    }

    /*
     * Still nothing means the document was created and then disappeared between
     * two round trips. Not a state a caller can do anything about — and
     * returning `start` here would hand the SAME number to every booking that
     * followed, which is the one outcome worse than a failed booking.
     */
    if (!updated) {
      throw new Error(`Could not reserve ${field} — the settings document is missing`);
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

    /*
     * Same fallback as `get()`, and the same reasoning: this is a PROMISED DATE,
     * not a price. A brand-new install has no settings document yet, and
     * refusing to say when a pickup is due — on the very first booking, before
     * anyone has had a chance to set the number — is a worse answer than the
     * schema default that document would be created with anyway.
     *
     * Five business days is that schema default, not a figure invented here.
     */
    return scalars?.slaBusinessDays ?? 5;
  },

  /**
   * Save the invoicing block.
   *
   * ⚠️ Seven fields used to be missing from this `$set` — the whole company
   * block, the terms wording and the bank ACCOUNT NAME. They were read back on
   * the next request from the stored document, so the screen showed the old
   * value and the person who had just typed their ABN saw it silently revert.
   * Worse, `saveInvoicing` in the service VALIDATES those same fields, so the
   * API refused a malformed ABN and then discarded a valid one.
   *
   * The consequence was not cosmetic: `companyName` and `companyAbn` are what
   * make the document a tax invoice, so no invoice this system rendered could
   * carry either.
   *
   * ── Why the list is written out rather than spread ────────────────────────
   * `$set: input` would also write `templates` and `logoUrl`, which are not
   * scalars on this document — one is its own collection and the other is a
   * derived link. Naming each field is what keeps a read-shaped object from
   * being written back verbatim, which is how the two drifted apart in the
   * first place.
   *
   * ⚠️ `logoKey` is deliberately NOT here. It is written by its own endpoints
   * after the bytes land, and a client echoing back a stale key must not be
   * able to repoint the logo.
   */
  async saveInvoicing(input: InvoicingSettings): Promise<void> {
    await SettingsModel.updateOne(
      { _id: SETTINGS_SINGLETON_ID },
      {
        $set: {
          invoiceNumberPrefix: input.invoiceNumberPrefix,
          splitAdditionalCharges: input.splitAdditionalCharges,
          defaultPaymentTermsDays: input.defaultPaymentTermsDays,
          companyName: input.companyName,
          companyAbn: input.companyAbn,
          companyAddress: input.companyAddress,
          companyPhone: input.companyPhone,
          companyEmail: input.companyEmail,
          termsText: input.termsText,
          footerText: input.footerText,
          bankBsb: input.bankBsb,
          bankAccount: input.bankAccount,
          bankAccountName: input.bankAccountName,
          showGbcaBadge: input.showGbcaBadge,
        },
      },
    );
  },

  /**
   * M7.5 — point the invoices at a logo, or take it away.
   *
   * Separate from `saveInvoicing` because the bytes and the record are written
   * at different moments: the browser PUTs the image to storage first, and only
   * a successful upload should change what the invoices print.
   */
  async setLogoKey(key: string): Promise<void> {
    await SettingsModel.updateOne({ _id: SETTINGS_SINGLETON_ID }, { $set: { logoKey: key } });
  },

  /** The stored logo key, or an empty string. */
  async logoKey(): Promise<string> {
    const row = await SettingsModel.findById(SETTINGS_SINGLETON_ID)
      .select({ logoKey: 1 })
      .lean<{ logoKey?: string }>();
    return row?.logoKey ?? '';
  },

  /**
   * Remove one rate schedule — the undo for a start date keyed wrong.
   *
   * ── Why the previous schedule has to be reopened ──────────────────────────
   * Issuing this one CLOSED the schedule before it, at the day before this
   * start. Deleting the row without undoing that close would leave the card
   * with a gap: every job dated after the old schedule's new end would price
   * against nothing, and `resolveRate` would refuse the booking with "no rate
   * covers this date" — on a card that looks complete on screen.
   *
   * So the previous schedule is re-extended to whatever this one was bounded
   * by, which is `null` when this was the last. That restores exactly the
   * state that existed before it was issued.
   */
  async deleteSchedule(id: RateCardId, effectiveFrom: string): Promise<boolean> {
    const from = startOfSydneyDay(effectiveFrom);

    const doomed = await ZoneRateModel.find({ rateCardId: id, effectiveFrom: from })
      .select({ effectiveTo: 1 })
      .lean<Array<{ effectiveTo: Date | null }>>();

    /*
     * Read BEFORE the delete, because the window this schedule occupied is what
     * the previous one has to be re-extended to. One row per zone, all sharing
     * the same window, so the first answers for all three.
     */
    const vacatedEnd = doomed[0]?.effectiveTo;
    if (vacatedEnd === undefined) return false;

    await ZoneRateModel.deleteMany({ rateCardId: id, effectiveFrom: from });

    /*
     * The row that ran up to the day before this one. Reopened to this
     * schedule's own end so the windows tile exactly as they did before.
     */
    const previous = await ZoneRateModel.findOne({
      rateCardId: id,
      effectiveFrom: { $lt: from },
    })
      .sort({ effectiveFrom: -1 })
      .select({ effectiveFrom: 1 })
      .lean<{ effectiveFrom: Date }>();

    if (previous) {
      await ZoneRateModel.updateMany(
        { rateCardId: id, effectiveFrom: previous.effectiveFrom },
        { $set: { effectiveTo: vacatedEnd } },
      );
    }

    return true;
  },

  /** Seeds the platform. Idempotent, so it is safe to run on every deploy. */
  async seed(data: {
    rateCards: Array<{ id: RateCardId; label: string; effectiveFrom: Date }>;
    /**
     * The zones themselves, written BEFORE the rates below.
     *
     * Keyed on `slug`, because that is the only stable handle a seed has — the
     * `_id` is minted by Mongo on first insert and must survive a re-run.
     */
    zones: Array<{ slug: string; label: string; displayOrder: number }>;
    zoneRates: Array<{
      rateCardId: RateCardId;
      zoneId: Zone;
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
    /*
     * Zones first, and awaited on their own before anything below runs.
     *
     * ⚠️ Parent before children, the same rule `lib/transaction.ts` states: a
     * seed that died between the two leaves zones with no rates — visible on
     * the settings screen and fixable there — rather than rate rows referencing
     * a zone nobody can see.
     *
     * `$setOnInsert` on every field: the seed INSTALLS a zone, it does not own
     * one. Re-running must not rename a zone the office has since renamed, or
     * drag it back to the position it was seeded in.
     */
    await Promise.all(
      data.zones.map((zone) =>
        ZoneModel.updateOne(
          { slug: zone.slug },
          {
            $setOnInsert: {
              label: zone.label,
              displayOrder: zone.displayOrder,
              archived: false,
            },
          },
          { upsert: true },
        ),
      ),
    );

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
            zoneId: rate.zoneId,
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
    rows
      .filter((row): row is { _id: string; count: number } => row._id !== null)
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
  zoneId: Zone,
  onDate: string,
): Promise<RawZoneRate | null> {
  /*
   * ⚠️ Not an id at all — answer "no rate" rather than throwing.
   *
   * Mongoose casts this value into the query, and `new ObjectId('sydney')`
   * throws. A caller holding a stale zone deserves the 503 that says no rate is
   * configured, which the office can act on, rather than a 500 that says
   * nothing.
   */
  if (!isObjectId(zoneId)) return null;
  const zoneObjectId = new Types.ObjectId(zoneId);

  const at = startOfSydneyDay(onDate);

  return ZoneRateModel.findOne({
    rateCardId,
    zoneId: zoneObjectId,
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
      zoneId: rate.zoneId,
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

/**
 * The charge whose price is settable but which nothing ever raises.
 *
 * ⚠️ Not a general "hidden charges" mechanism, and deliberately a single
 * constant rather than a list: a second entry here would mean somebody was
 * hiding a control instead of fixing it. See the note where it is filtered.
 */
const UNBILLED_SERVICE_CODE = 'extra-load-time';

/**
 * A short-lived link to the stored logo, or null.
 *
 * Never throws. A logo that cannot be read is a gap on a settings screen, and
 * failing the whole settings request over it would take down pricing, rate
 * cards and invoicing with it — for a thumbnail.
 */
async function logoUrlFor(key: string): Promise<string | null> {
  if (key.trim() === '') return null;

  try {
    return await getStorage().presignDownload(key);
  } catch {
    return null;
  }
}
