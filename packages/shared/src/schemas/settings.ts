import * as z from 'zod';
import {
  IsoDateSchema,
  MoneySchema,
  NonEmptyStringSchema,
  NonNegativeMoneySchema,
} from './primitives.js';
import { BrandIdSchema, RateCardIdSchema, ZoneSchema, ZoneSlugSchema } from './party.js';

/**
 * Settings (W3), plus brands (M1.1), rate cards (M6) and invoice branding (M7.5).
 *
 * ── Editable versus displayed ─────────────────────────────────────────────
 * Some of what belongs on a settings screen is NOT a setting, and pretending
 * otherwise would be worse than leaving it out:
 *
 *  • **Rate schedules are effective-dated** (M6.2): pricing a job always uses the
 *    rates in force on that job's date, so "editing" a rate means issuing a new
 *    schedule, never overwriting the old one. The UI reflects that.
 *
 * The client's answer to the rest of that category was to drop it: read-only
 * facts earn no screen space. See the note where `general` used to be.
 *
 * ── The invoice-template trap ─────────────────────────────────────────────
 * Scope Call 1: **branding and content control are IN** (logo, colours, company
 * details, terms, bank details, footer, visible columns). **Template resolution
 * simplifies to per-customer assignment** — Matt: *"I don't need this level of
 * granularity."* Layout authoring is a pending decision (Risk 5), so this
 * contract has no concept of a layout, band or expression. That absence is the
 * design.
 */

/* ── Zone rates, which belong to a rate card (M6) ─────────────────────────── */

export const ZoneRateSchema = z
  .object({
    zoneId: ZoneSchema,
    /** The zone's name, so a rate table renders without holding a zone map. */
    zoneLabel: NonEmptyStringSchema,
    /*
     * Deliberately permissive, unlike `ZoneRateInput` below.
     *
     * This is a RESPONSE shape. Tightening it would mean one bad stored row
     * fails the whole settings payload and blanks the screen, which is exactly
     * how a single malformed record can hide everything else. The refusal
     * belongs on the way in, where somebody can still be told about it.
     */
    serviceCharge: MoneySchema,
    ratePerM2: MoneySchema,
  })
  .meta({ id: 'ZoneRate' });

/**
 * One effective-dated version of a card's rates (M6.2).
 *
 * ── Why the SCHEDULE is the versioned thing, not the card ─────────────────
 * A rate card is a commercial relationship — "Clarendon & Domaine" — and it
 * does not end when its prices change. What changes is the schedule of rates
 * under it. So a card has many schedules, exactly one of which is in force on
 * any given date, and a job is priced by the schedule covering ITS date.
 *
 * `effectiveTo` empty means open-ended, which is the normal case: a schedule
 * applies until a later one supersedes it. Issuing a new schedule closes the
 * previous one the day before the new one starts, so the windows tile the
 * calendar with no gap and no overlap.
 */
export const RateScheduleSchema = z
  .object({
    effectiveFrom: IsoDateSchema,
    /** Empty means open-ended — in force until something supersedes it. */
    effectiveTo: z.string(),
    zones: z.array(ZoneRateSchema),
  })
  .meta({ id: 'RateSchedule' });

/**
 * The rates as applied to one job, frozen at the moment it was priced (M6.2).
 *
 * ⚠️ This is what makes effective dating safe rather than merely stored. A
 * reprint, a credit note or a reissue reads THIS, and never asks the rate
 * tables again — so a schedule issued next March cannot move a figure on an
 * invoice the customer has already paid, even if the schedule that priced it
 * were later corrected or deleted.
 */
export const AppliedRateSchema = z
  .object({
    rateCardId: RateCardIdSchema,
    /** The card's name as it read when the job was priced. */
    rateCardLabel: NonEmptyStringSchema,
    zoneId: ZoneSchema,
    /**
     * The zone's name as it read when the job was priced.
     *
     * ⚠️ Frozen text, exactly like `rateCardLabel` above, and NOT re-resolved
     * from `zoneId`. Renaming a zone must never rewrite the description on an
     * invoice the customer has already paid.
     */
    zoneLabel: NonEmptyStringSchema,
    /** Which schedule priced it, so a dispute can be traced to a decision. */
    scheduleFrom: IsoDateSchema,
    serviceCharge: MoneySchema,
    ratePerM2: MoneySchema,
  })
  .meta({ id: 'AppliedRate' });

/*
 * There is no `GeneralSettingsSchema`, and the settings payload has no
 * `general` block.
 *
 * It carried six values and the client wanted none of them on screen. Timezone,
 * data region and the retention floor were constants dressed as settings; the
 * zone list duplicated `pricing.rateCards`; and the two number sequences are
 * counters nobody may type. That left `slaBusinessDays` alone.
 *
 * ⚠️ `slaBusinessDays` and both sequences still EXIST — they are stored on the
 * settings singleton and are load-bearing:
 *
 *  • the SLA is every job's target date (M2.4a), read through
 *    `settingsRepository.slaBusinessDays()`
 *  • the sequences number every job and invoice (M1.4), taken through
 *    `settingsRepository.takeNextNumber()`
 *
 * What was removed is the *settings surface* over them — the read block, the
 * `PUT /settings/general` route and the screen. Changing the SLA is now a seed
 * or a migration, which is the trade the client accepted.
 */

/*
 * ── There is no notification-rules block, and no integrations block ────────
 *
 * Both were settings SURFACES over things that were configured elsewhere, and
 * neither was ever read:
 *
 *  • The per-event SMS/email matrix was never consulted by the sender.
 *    `outboundService` chooses a channel from the RECIPIENT's own
 *    `notifyByEmail` / `notifyBySms` (M8.4), which is the preference that
 *    actually belongs to a person rather than to the platform. A second,
 *    platform-wide switch that silently did nothing was worse than no switch.
 *  • The integrations board reported connection state for six services whose
 *    credentials live in the environment. It could not configure any of them,
 *    and its "test connection" button recorded an outcome rather than
 *    performing a check.
 *
 * ⚠️ The notification CENTRE (the bell, `notifications` + `outboundmessages`)
 * and all outbound email and SMS are untouched and still live — they are a
 * different domain entirely. Only the dead settings block is gone.
 *
 * Driver credential types went the same way. Driver licences, tickets and their
 * expiry tracking are still on the driver profile (`DriverCredentialSchema` in
 * `fleet.ts`); what was removed is the per-type reminder-lead-time register,
 * which nothing read.
 */

/* ── Pricing (M6) ─────────────────────────────────────────────────────────── */

export const RateCardSummarySchema = z
  .object({
    id: RateCardIdSchema,
    label: NonEmptyStringSchema,
    accountCount: z.number().int().nonnegative(),
    /** M6.2 — rates are versioned; a job is priced by the date it ran. */
    effectiveFrom: z.string(),
    effectiveTo: z.string(),
    /**
     * The schedule in force TODAY, flattened for the screens that only want
     * current prices — the quote header, the customer detail page.
     *
     * Empty where a card has no schedule covering today, which is a real state
     * worth showing rather than hiding: a card whose only schedule starts next
     * month prices nothing until then, and falls back to `default`.
     */
    zones: z.array(ZoneRateSchema),
    /** Every schedule, newest first — the history the office audits against. */
    schedules: z.array(RateScheduleSchema),
    /**
     * Whether this card may be deleted. False for `default`, which is the
     * fallback every other card relies on, and for any card an account names.
     *
     * Computed by the server rather than inferred by the browser: the account
     * count is only part of it, and a UI that guessed would offer a delete that
     * comes back 409.
     */
    deletable: z.boolean(),
  })
  .meta({ id: 'RateCardSummary' });

/* ── Writing rates (M6.1, M6.2) ───────────────────────────────────────────── */

/**
 * One zone's prices, as typed into the schedule form.
 *
 * ⚠️ `ratePerM2` carries FOUR decimal places, not two. It is a rate, not an
 * amount: rounding $0.1625 to $0.16 before multiplying by 823.41 m² loses real
 * money on every large job, and a month of them adds up to a reconciliation
 * nobody can explain.
 */
export const ZoneRateInputSchema = z
  .object({
    zoneId: ZoneSchema,
    /*
     * ⚠️ Non-negative. `MoneySchema` permits a leading minus, and a schedule
     * issued with `serviceCharge: "-220.00"` saved cleanly with a 201 — every
     * job priced on that card from its start date would then bill the customer
     * minus two hundred dollars. Nothing in v1 credits anybody (see
     * `XeroSyncState`), and because rates are effective-dated it would price
     * silently until somebody read an invoice.
     *
     * Zero stays legal: a card that charges no call-out is a real arrangement.
     */
    serviceCharge: NonNegativeMoneySchema,
    ratePerM2: NonNegativeMoneySchema,
  })
  .meta({ id: 'ZoneRateInput' });

/**
 * The zone rates on one schedule, as far as a schema can check them.
 *
 * A schedule missing a zone is not a half-finished schedule — it is a card that
 * silently falls back to `default` for that zone, which is how a builder ends
 * up invoiced at somebody else's rate.
 *
 * ── What moved, and why ───────────────────────────────────────────────────
 * This used to assert `.length(ZONES.length)` and that every member of `ZONES`
 * appeared. Neither is expressible now: the zone list is a collection, and a
 * contract package must not read one.
 *
 * ⚠️ COMPLETENESS IS STILL ENFORCED — it moved to
 * `settingsService.assertPricesEveryZone`, which checks the array against the
 * zones that actually exist and answers with a 422 naming each missing one.
 * That is a stronger check than this ever was: the old one counted to three and
 * would have passed a schedule pricing Sydney three times.
 */
const ZoneRatesSchema = z
  .array(ZoneRateInputSchema)
  .min(1, 'Price at least one zone')
  .refine((rates) => new Set(rates.map((rate) => rate.zoneId)).size === rates.length, {
    message: 'Each zone may appear only once',
  });

/** A brand-new card, with its opening schedule. */
export const RateCardCreateSchema = z
  .object({
    /**
     * Optional: derived from the label when absent, which is what the form
     * does. Supplied explicitly only when migrating a card that must keep the
     * id an external system already knows.
     */
    id: RateCardIdSchema.optional(),
    /*
     * Worded, because unlabelled Zod answers an empty name with "Too small:
     * expected string to have >=1 characters" — raw validator output on a
     * screen whose other messages are written for the office.
     */
    label: z
      .string()
      .trim()
      .min(1, 'Name the rate card — the office picks it by this on a customer')
      .max(80, 'Keep the name under 80 characters'),
    effectiveFrom: IsoDateSchema,
    zones: ZoneRatesSchema,
  })
  .meta({ id: 'RateCardCreate' });

/**
 * A new schedule on an existing card — the ONLY way rates change (M6.2).
 *
 * There is deliberately no "update this schedule's prices" route. Editing a
 * rate in place would reprice every job already priced by it, and invoice
 * correctness is the highest-rated risk in the project.
 */
export const RateScheduleCreateSchema = z
  .object({
    effectiveFrom: IsoDateSchema,
    zones: ZoneRatesSchema,
  })
  .meta({ id: 'RateScheduleCreate' });

/** Renaming a card. Its rates are not reachable from here, by design. */
export const RateCardUpdateSchema = z
  .object({ label: NonEmptyStringSchema.max(80) })
  .meta({ id: 'RateCardUpdate' });

/** M6.5 — the chargeable extras, fixed and percentage. */
export const AdditionalServiceSettingSchema = z
  .object({
    code: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    kind: z.enum(['fixed', 'percentage']),
    /** A decimal string for fixed; a percentage figure for percentage. */
    value: NonEmptyStringSchema,
    requiresApproval: z.boolean(),
    driverRaisable: z.boolean(),
    /** Extra Load Time is `system` — hence *Created By: System* in the queue. */
    systemGenerated: z.boolean(),
    /**
     * Whether this charge may be deleted (M6.5).
     *
     * False for the codes the application looks up BY NAME — see
     * `PROTECTED_SERVICE_CODES`. Their price and label are editable; their
     * existence is not, because deleting one breaks a workflow rather than
     * removing a line from a list.
     */
    deletable: z.boolean(),
  })
  .meta({ id: 'AdditionalServiceSetting' });

/**
 * The charges the code reaches for by literal code, and so may never be
 * deleted.
 *
 * ⚠️ Each of these is looked up by name somewhere that would throw without it:
 *
 *  • `recycling-bags`  — priced into every quote (`pricingService.quote`)
 *  • `futile-pickup`   — raised when the office confirms a futile (M2.6)
 *  • `contamination`   — raised by a driver at the fence (M4.6)
 *  • `extra-bags`      — derived from bag count over the order's allowance
 *  • `extra-load-time` — derived from on-site duration
 *
 * Repricing them is exactly what the settings screen is for. Removing them is
 * a code change, so the API refuses it rather than letting an administrator
 * discover it through a 500 on a driver's phone.
 */
export const PROTECTED_SERVICE_CODES = [
  'recycling-bags',
  'futile-pickup',
  'contamination',
  'extra-bags',
  'extra-load-time',
] as const;

/**
 * A `code` an administrator may type.
 *
 * Slug-shaped for the same reason a rate card id is: it is an identifier the
 * driver app and the invoice both carry, not a display string.
 */
export const ServiceCodeSchema = z
  .string()
  .trim()
  .min(1, 'A charge needs a code')
  .max(40, 'Keep the code short')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and hyphens only')
  .meta({ id: 'ServiceCode' });

/**
 * The editable half of a charge.
 *
 * `kind` is absent on purpose: switching a $90 fixed charge into a 90%
 * percentage would silently reprice every future job by a factor of thousands.
 * Changing kind means retiring the charge and adding a new one, which is a
 * decision somebody has to make deliberately.
 */
export const AdditionalServiceUpdateSchema = z
  .object({
    label: NonEmptyStringSchema.max(80),
    value: MoneySchema,
    requiresApproval: z.boolean(),
  })
  .meta({ id: 'AdditionalServiceUpdate' });

/*
 * ── `driverRaisable` is no longer writable, and the control is gone ────────
 *
 * ⚠️ It was a checkbox over a value NOTHING read. The driver app offers a fixed
 * set of screens — report contamination, report futile — and decides what to
 * show from those screens existing, never from this flag. So ticking it changed
 * a database column and nothing else, while promising an administrator they had
 * just put a button on a driver's phone.
 *
 * The FIELD survives on the model and in the read contract: the seed sets it,
 * and removing a stored value is a migration rather than a schema edit. What is
 * gone is the ability to change it and the screen that offered to.
 */

export const AdditionalServiceCreateSchema = AdditionalServiceUpdateSchema.extend({
  code: ServiceCodeSchema,
  kind: z.enum(['fixed', 'percentage']),
})
  /*
   * `systemGenerated` is NOT settable. It means "derived by the application
   * from data the driver captured", which is a property of code that exists,
   * not a flag: ticking it on a hand-made charge would put *Created By: System*
   * on the approvals queue next to something a person invented.
   */
  .meta({ id: 'AdditionalServiceCreate' });

/**
 * M7.5 — asking for somewhere to put the invoice logo.
 *
 * ── Why the bytes do not come through this API ────────────────────────────
 * The browser PUTs them straight to storage against a presigned URL, the same
 * way a driver's photos and a lead's attachments already do. Routing a logo
 * through Node would mean a body parser sized for images on every request this
 * service handles, to save one round trip on something done once a year.
 */
export const LogoUploadRequestSchema = z
  .object({
    /**
     * ⚠️ Raster or SVG both refused except for the three below.
     *
     * The renderer draws with `pdf-lib`, which embeds PNG and JPEG and nothing
     * else. Accepting an SVG here would store a file that silently fails to
     * appear on every invoice afterwards — the fallback is the company name in
     * text, so nobody would see an error, just a missing logo.
     */
    contentType: z.enum(['image/png', 'image/jpeg', 'image/jpg']),
    /**
     * Capped at 2 MB. A logo is a letterhead mark a few hundred pixels wide;
     * anything larger is a photograph somebody has picked by mistake, and it
     * would be embedded in every invoice PDF the business ever sends.
     */
    contentLength: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024, 'A logo must be 2 MB or smaller'),
  })
  .meta({ id: 'LogoUploadRequest' });

export type LogoUploadRequest = z.infer<typeof LogoUploadRequestSchema>;

/**
 * M7.5 — a rendered sample of one invoice template.
 *
 * ⚠️ Drawn from INVENTED figures, never from a real invoice. A preview that
 * pulled the most recent invoice would put one customer's job, address and
 * amounts on screen for whoever happened to be editing a template.
 *
 * The URL is short-lived, like every other storage link.
 */
export const TemplatePreviewSchema = z
  .object({
    url: NonEmptyStringSchema,
    fileName: NonEmptyStringSchema,
  })
  .meta({ id: 'TemplatePreview' });

export type TemplatePreview = z.infer<typeof TemplatePreviewSchema>;

/* ── Zones (M6.3) ─────────────────────────────────────────────────────────── */

/**
 * One service area, as the settings screen reads it.
 *
 * ⚠️ `slug` is the human handle and `id` is the key. Five collections point at
 * the id; nothing joins on the slug. Renaming changes neither — only `label`.
 */
export const ZoneSummarySchema = z
  .object({
    id: ZoneSchema,
    slug: ZoneSlugSchema,
    label: NonEmptyStringSchema,
    displayOrder: z.number().int().nonnegative(),
    archived: z.boolean(),
    /**
     * What stands behind this zone. The screen shows these before it offers to
     * retire one, because retiring a zone nothing points at is housekeeping and
     * retiring one with fifty jobs behind it is a decision.
     */
    placeCount: z.number().int().nonnegative(),
    accountCount: z.number().int().nonnegative(),
    jobCount: z.number().int().nonnegative(),
    /**
     * Whether this zone may be retired. Computed by the server, never stored —
     * the same split as `RateCardSummary.deletable`, and for the same reason: a
     * UI that guessed would offer a retire that comes back 409.
     */
    archivable: z.boolean(),
  })
  .meta({ id: 'ZoneSummary' });

export type ZoneSummary = z.infer<typeof ZoneSummarySchema>;

/** A new service area, priced by copying one that already exists. */
export const ZoneCreateSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, 'Name the zone — it appears on every rate card and quote')
      .max(60, 'Keep the name under 60 characters'),
    /**
     * ⚠️ Required, with no default.
     *
     * A zone created with no prices prices NOTHING on any card, and the first
     * sign of it is a 503 on a booking form weeks later. Making the caller
     * nominate a source is what turns "add a zone" into a complete act — and
     * copying per card preserves each customer's negotiated discount instead of
     * flattening every card to one number.
     */
    copyRatesFromZoneId: ZoneSchema,
  })
  .meta({ id: 'ZoneCreate' });

export type ZoneCreate = z.infer<typeof ZoneCreateSchema>;

/** Renaming a zone. Its id, its slug and its rates are not reachable from here. */
export const ZoneUpdateSchema = z
  .object({
    label: z.string().trim().min(1, 'Name the zone').max(60, 'Keep the name under 60 characters'),
  })
  .meta({ id: 'ZoneUpdate' });

export type ZoneUpdate = z.infer<typeof ZoneUpdateSchema>;

/**
 * The whole list, in the order it should read.
 *
 * A whole-list PUT rather than a per-zone `displayOrder` PATCH: two PATCHes can
 * leave two zones claiming the same position, and the sort is then whatever
 * Mongo returns — which is the exact bug the old `ZONES.indexOf` prevented by
 * accident.
 */
export const ZoneOrderSchema = z
  .object({
    zoneIds: z.array(ZoneSchema).min(1, 'Send the whole list'),
  })
  .meta({ id: 'ZoneOrder' });

export type ZoneOrder = z.infer<typeof ZoneOrderSchema>;

export const PricingSettingsSchema = z
  .object({
    /**
     * The service areas, in display order (M6.3).
     *
     * First, because zones are the COLUMNS of everything below them: every rate
     * schedule prices one row per zone and the server refuses a partial one.
     */
    zones: z.array(ZoneSummarySchema),
    rateCards: z.array(RateCardSummarySchema),
    additionalServices: z.array(AdditionalServiceSettingSchema),
    /**
     * M6.8 — the flat per-job cost the margin figure assumes today.
     *
     * ⚠️ No longer shown on the settings screen, but very much still live: the
     * financial summary report (M9.6) computes every margin figure from it. It
     * is a seed-time value now, like the SLA.
     */
    assumedCostPerJob: MoneySchema,
  })
  .meta({ id: 'PricingSettings' });

/* ── Invoicing (M7) ───────────────────────────────────────────────────────── */

/**
 * Which of the shipped layouts a template draws with (M7.5).
 *
 * ── Why the LAYOUT is a fixed union and the template is a record ──────────
 * An administrator controls what a template says — its name, its brand, its
 * accent colour, which quantity columns print. They do not control where the
 * logo sits or how the table is ruled, because a layout is code: it is drawn
 * by the renderer, and a drag-and-drop designer is a product in its own right
 * and the single biggest scope trap in this project.
 *
 * So a template POINTS AT a layout. Adding a sixth layout is a deploy; adding
 * a sixth template is a click.
 */
export const INVOICE_LAYOUTS = ['standard', 'detailed', 'compact', 'rcti'] as const;
export const InvoiceLayoutSchema = z.enum(INVOICE_LAYOUTS).meta({ id: 'InvoiceLayout' });
export type InvoiceLayout = z.infer<typeof InvoiceLayoutSchema>;

export const INVOICE_LAYOUT_LABELS: Record<InvoiceLayout, string> = {
  standard: 'Standard',
  detailed: 'Detailed — job and site breakdown',
  compact: 'Compact — one page, totals led',
  rcti: 'RCTI — recipient created tax invoice',
};

export const INVOICE_LAYOUT_DESCRIPTIONS: Record<InvoiceLayout, string> = {
  standard: 'The everyday invoice: line items, totals, payment details.',
  detailed: 'Adds the job number, site address and collection date against each line.',
  compact: 'Totals and payment details first, lines condensed. For high-volume accounts.',
  rcti: 'The customer raises this one. Carries the RCTI wording the ATO requires.',
};

export const InvoiceTemplateSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    brandId: BrandIdSchema,
    /** Which quantity columns it prints — m² only, or m² and kg. */
    showsWeight: z.boolean(),
    /** Which shipped layout draws it. */
    layout: InvoiceLayoutSchema,
    /**
     * The heading rule and table accent, as `#rrggbb`.
     *
     * Per template rather than per brand: EasyLift and PlastaGo differ, but so
     * can two PlastaGo templates — a builder on an RCTI arrangement gets a
     * visibly different document on purpose, so nobody files it as an invoice.
     */
    accentColour: z.string(),
    assignedAccountCount: z.number().int().nonnegative(),
    /** False while any account still names it — deleting would strand them. */
    deletable: z.boolean(),
  })
  .meta({ id: 'InvoiceTemplate' });

/** A hex colour an administrator may type. `#` required, six digits. */
export const HexColourSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, e.g. #1a4d3a')
  .meta({ id: 'HexColour' });

export const InvoiceTemplateWriteSchema = z
  .object({
    name: NonEmptyStringSchema.max(80),
    brandId: BrandIdSchema,
    showsWeight: z.boolean(),
    layout: InvoiceLayoutSchema,
    accentColour: HexColourSchema,
  })
  .meta({ id: 'InvoiceTemplateWrite' });

export const InvoicingSettingsSchema = z
  .object({
    templates: z.array(InvoiceTemplateSchema),
    /**
     * Printed in front of every invoice number — "PGA-104312".
     *
     * Matt, 7:07: *"customisable invoice number prefixes. In the settings of the
     * app, select the prefix like, for example, if we had PGA, it would put PGA
     * dash in front of the invoice number."*
     *
     * ── Why it is a prefix and not part of the number ─────────────────────
     * The number itself is a sequence that must never collide or restart — it
     * continues from ~104,100 (M1.4) and Xero matches on it. The prefix is
     * presentation: changing it must not renumber a single existing invoice, and
     * keeping the two apart is what guarantees that.
     *
     * Empty is valid and means bare numbers, which is what they use today.
     */
    invoiceNumberPrefix: z
      .string()
      .trim()
      .max(8, 'Keep it short — it sits in front of every invoice number')
      .regex(/^[A-Za-z0-9-]*$/, 'Letters, digits and hyphens only'),
    /** M7.2 — base invoice now, additional charges on their own PO later. */
    splitAdditionalCharges: z.boolean(),
    /**
     * ⚠️ The bounds carry their own words.
     *
     * Unlabelled, Zod answered a mistyped figure with "Too small: expected
     * number to be >=0" and "Too big: expected number to be <=90" — raw
     * validator output on a screen whose every other message is written in the
     * office's language. 0 is deliberately allowed: due on receipt.
     */
    defaultPaymentTermsDays: z
      .number()
      .int('Whole days only')
      .min(0, 'Payment terms cannot be negative — use 0 for due on receipt')
      .max(90, 'Ninety days is the longest term we invoice on — check the figure'),

    /*
     * ── Branding, which is what Scope Call 1 puts in scope ────────────────
     *
     * Everything the invoice PDF prints that is not the invoice itself. All of
     * it is optional and every field degrades to "leave it off the page"
     * rather than to a placeholder: a document that says "Company Name Here"
     * has gone to a customer, and that is worse than one with a gap.
     */

    /**
     * Storage key for the logo — NOT a URL.
     *
     * The renderer reads the bytes through `StorageProvider.get`, so nothing
     * about invoice generation depends on a public bucket or a signed URL that
     * might have expired. Empty means print the company name as text instead.
     */
    logoKey: z.string(),

    /** The legal entity, as it must appear on a tax invoice. */
    companyName: z.string(),
    /**
     * ⚠️ Required on a valid Australian tax invoice over $82.50.
     *
     * Stored as typed — formatting is the renderer's job — but its ABSENCE is
     * what matters: an invoice without one is not a tax invoice, and the
     * customer's accounts department is entitled to reject it.
     */
    companyAbn: z.string(),
    companyAddress: z.string(),
    companyPhone: z.string(),
    companyEmail: z.string(),

    /** Payment terms wording, printed under the totals. */
    termsText: z.string(),
    footerText: z.string(),
    bankBsb: z.string(),
    bankAccount: z.string(),
    /** The account NAME the payment goes to. A BSB and number alone are not enough. */
    bankAccountName: z.string(),
    showGbcaBadge: z.boolean(),
  })
  .meta({ id: 'InvoicingSettings' });

/**
 * What the settings SCREEN receives, as opposed to what it sends back.
 *
 * ── Why the read and the write are not the same shape ─────────────────────
 * `logoUrl` is derived — a short-lived link minted from `logoKey` so the screen
 * can show the mark that is actually on the invoices. It must not be part of
 * the write: a client echoing back a URL that expired ten minutes ago would be
 * asking the server to store a dead link as the logo.
 *
 * So the write stays `InvoicingSettingsSchema` and this is read-only. The
 * server ignores the field if a client sends it, which is what Zod's default
 * stripping already does.
 */
export const InvoicingSettingsReadSchema = InvoicingSettingsSchema.extend({
  /** Null when no logo has been uploaded, or when the stored one cannot be read. */
  logoUrl: z.string().nullable(),
}).meta({ id: 'InvoicingSettingsRead' });

export const SettingsSchema = z
  .object({
    pricing: PricingSettingsSchema,
    invoicing: InvoicingSettingsReadSchema,
  })
  .meta({ id: 'Settings' });

export type ZoneRate = z.infer<typeof ZoneRateSchema>;
export type RateSchedule = z.infer<typeof RateScheduleSchema>;
export type AppliedRate = z.infer<typeof AppliedRateSchema>;
export type RateCardSummary = z.infer<typeof RateCardSummarySchema>;
export type ZoneRateInput = z.infer<typeof ZoneRateInputSchema>;
export type RateCardCreate = z.infer<typeof RateCardCreateSchema>;
export type RateScheduleCreate = z.infer<typeof RateScheduleCreateSchema>;
export type RateCardUpdate = z.infer<typeof RateCardUpdateSchema>;
export type AdditionalServiceSetting = z.infer<typeof AdditionalServiceSettingSchema>;
export type AdditionalServiceCreate = z.infer<typeof AdditionalServiceCreateSchema>;
export type AdditionalServiceUpdate = z.infer<typeof AdditionalServiceUpdateSchema>;
export type PricingSettings = z.infer<typeof PricingSettingsSchema>;
export type InvoiceTemplate = z.infer<typeof InvoiceTemplateSchema>;
export type InvoiceTemplateWrite = z.infer<typeof InvoiceTemplateWriteSchema>;
export type InvoicingSettings = z.infer<typeof InvoicingSettingsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
