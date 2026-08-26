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
 *  • **Data residency and the 7-year retention floor** are commitments in the
 *    client's Privacy Policy (M1.7). They are facts, shown read-only.
 *  • **Number sequences** continue from ~61,300 and ~104,100 (M1.4) and need a
 *    transactional counter. The current value is displayed; it is not a text box.
 *  • **Rate schedules are effective-dated** (M6.2): pricing a job always uses the
 *    rates in force on that job's date, so "editing" a rate means issuing a new
 *    schedule, never overwriting the old one. The UI reflects that.
 *
 * ── The invoice-template trap ─────────────────────────────────────────────
 * Scope Call 1: **branding and content control are IN** (logo, colours, company
 * details, terms, bank details, footer, visible columns). **Template resolution
 * simplifies to per-customer assignment** — Matt: *"I don't need this level of
 * granularity."* Layout authoring is a pending decision (Risk 5), so this
 * contract has no concept of a layout, band or expression. That absence is the
 * design.
 */

/* ── General ──────────────────────────────────────────────────────────────── */

export const ZoneRateSchema = z
  .object({
    zone: ZoneSchema,
    serviceCharge: MoneySchema,
    ratePerM2: MoneySchema,
  })
  .meta({ id: 'ZoneRate' });

export const GeneralSettingsSchema = z
  .object({
    /** M2.4a — target date is the customer's ready date plus this many. */
    slaBusinessDays: z.number().int().min(1).max(30),
    /** Read-only facts, shown so nobody has to go and ask. */
    timezone: NonEmptyStringSchema,
    dataRegion: NonEmptyStringSchema,
    retentionYears: z.number().int(),
    nextJobNumber: z.number().int().positive(),
    nextInvoiceNumber: z.number().int().positive(),
    zones: z.array(ZoneRateSchema),
  })
  .meta({ id: 'GeneralSettings' });

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
    general: GeneralSettingsSchema,
    notifications: NotificationSettingsSchema,
    pricing: PricingSettingsSchema,
    invoicing: InvoicingSettingsSchema,
    integrations: z.array(IntegrationSchema),
    credentialTypes: z.array(CredentialTypeSettingSchema),
  })
  .meta({ id: 'Settings' });

export type ZoneRate = z.infer<typeof ZoneRateSchema>;
export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>;
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
