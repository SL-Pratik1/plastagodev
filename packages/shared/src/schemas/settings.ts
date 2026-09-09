import * as z from 'zod';
import { MoneySchema, NonEmptyStringSchema } from './primitives.js';
import { BrandIdSchema, RateCardIdSchema, ZoneSchema } from './party.js';
import { CredentialTypeSchema } from './fleet.js';

/**
 * Settings (W3), plus brands (M1.1), rate cards (M6) and integrations (W7).
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
    zone: ZoneSchema,
    serviceCharge: MoneySchema,
    ratePerM2: MoneySchema,
  })
  .meta({ id: 'ZoneRate' });

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

/* ── Notifications (M8.3, M8.4 · W5, W14) ─────────────────────────────────── */

export const NOTIFICATION_EVENTS = [
  'job-booked',
  'job-allocated',
  'driver-on-the-way',
  'job-completed',
  'job-futile',
  'job-rescheduled',
  'upcoming-reminder',
] as const;
export const NotificationEventSchema = z
  .enum(NOTIFICATION_EVENTS)
  .meta({ id: 'NotificationEvent' });
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  'job-booked': 'Job booked',
  'job-allocated': 'Job allocated',
  'driver-on-the-way': 'Driver on the way',
  'job-completed': 'Job completed',
  'job-futile': 'Futile pickup',
  'job-rescheduled': 'Job rescheduled',
  'upcoming-reminder': 'Upcoming job reminder',
};

export const NotificationRuleSchema = z
  .object({
    event: NotificationEventSchema,
    sms: z.boolean(),
    email: z.boolean(),
    /** M8.2 — the completion email carries the job photos. */
    includePhotos: z.boolean(),
  })
  .meta({ id: 'NotificationRule' });

export const NotificationSettingsSchema = z
  .object({
    rules: z.array(NotificationRuleSchema),
    /** M8.3 — how far ahead the readiness reminder goes out. */
    reminderLeadDays: z.number().int().min(1).max(7),
    /**
     * M8.3 — the committed implementation is a tap-through link to the reschedule
     * screen, NOT inbound SMS parsing (F65's stretch). Cheaper, unambiguous and
     * fully audited.
     */
    reminderIncludeRescheduleLink: z.boolean(),
    /** M8.7 — the internal daily digest for the queues. */
    queueDigestEnabled: z.boolean(),
    queueDigestHour: z.number().int().min(0).max(23),
  })
  .meta({ id: 'NotificationSettings' });

/* ── Pricing (M6) ─────────────────────────────────────────────────────────── */

export const RateCardSummarySchema = z
  .object({
    id: RateCardIdSchema,
    label: NonEmptyStringSchema,
    accountCount: z.number().int().nonnegative(),
    /** M6.2 — rates are versioned; a job is priced by the date it ran. */
    effectiveFrom: z.string(),
    effectiveTo: z.string(),
    zones: z.array(ZoneRateSchema),
  })
  .meta({ id: 'RateCardSummary' });

/** M6.5 — all nine, fixed and percentage. */
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
  })
  .meta({ id: 'AdditionalServiceSetting' });

export const PricingSettingsSchema = z
  .object({
    rateCards: z.array(RateCardSummarySchema),
    additionalServices: z.array(AdditionalServiceSettingSchema),
    /** M6.8 — the flat per-job cost the margin figure assumes today. */
    assumedCostPerJob: MoneySchema,
  })
  .meta({ id: 'PricingSettings' });

/* ── Invoicing (M7) ───────────────────────────────────────────────────────── */

export const InvoiceTemplateSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    brandId: BrandIdSchema,
    /** Which quantity columns it prints — m² only, or m² and kg. */
    showsWeight: z.boolean(),
    assignedAccountCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'InvoiceTemplate' });

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
    defaultPaymentTermsDays: z.number().int().min(0).max(90),
    /** Branding, which is what Scope Call 1 puts in scope. */
    footerText: z.string(),
    bankBsb: z.string(),
    bankAccount: z.string(),
    showGbcaBadge: z.boolean(),
  })
  .meta({ id: 'InvoicingSettings' });

/* ── Integrations (W7) ────────────────────────────────────────────────────── */

export const INTEGRATION_IDS = [
  'xero',
  'twilio',
  'google-maps',
  'm365-smtp',
  'm365-outlook',
  'mistral-ocr',
] as const;
export const IntegrationIdSchema = z.enum(INTEGRATION_IDS).meta({ id: 'IntegrationId' });
export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

export const INTEGRATION_STATES = ['connected', 'not-configured', 'error'] as const;
export const IntegrationStateSchema = z.enum(INTEGRATION_STATES).meta({ id: 'IntegrationState' });
export type IntegrationState = z.infer<typeof IntegrationStateSchema>;

export const IntegrationSchema = z
  .object({
    id: IntegrationIdSchema,
    name: NonEmptyStringSchema,
    purpose: NonEmptyStringSchema,
    state: IntegrationStateSchema,
    lastSuccessAt: z.string().nullable(),
    detail: z.string().nullable(),
    /** Stated caveats that belong on screen, not in a doc nobody reopens. */
    caveat: z.string().nullable(),
  })
  .meta({ id: 'Integration' });

/* ── Credential types (F53) ───────────────────────────────────────────────── */

export const CredentialTypeSettingSchema = z
  .object({
    type: CredentialTypeSchema,
    label: NonEmptyStringSchema,
    /** Matt's preference: define the type once, set the lead time per type. */
    reminderLeadDays: z.number().int().min(1).max(180),
    requiredForDrivers: z.boolean(),
  })
  .meta({ id: 'CredentialTypeSetting' });

export const SettingsSchema = z
  .object({
    notifications: NotificationSettingsSchema,
    pricing: PricingSettingsSchema,
    invoicing: InvoicingSettingsSchema,
    integrations: z.array(IntegrationSchema),
    credentialTypes: z.array(CredentialTypeSettingSchema),
  })
  .meta({ id: 'Settings' });

export type ZoneRate = z.infer<typeof ZoneRateSchema>;
export type NotificationRule = z.infer<typeof NotificationRuleSchema>;
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export type RateCardSummary = z.infer<typeof RateCardSummarySchema>;
export type AdditionalServiceSetting = z.infer<typeof AdditionalServiceSettingSchema>;
export type PricingSettings = z.infer<typeof PricingSettingsSchema>;
export type InvoiceTemplate = z.infer<typeof InvoiceTemplateSchema>;
export type InvoicingSettings = z.infer<typeof InvoicingSettingsSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type CredentialTypeSetting = z.infer<typeof CredentialTypeSettingSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
