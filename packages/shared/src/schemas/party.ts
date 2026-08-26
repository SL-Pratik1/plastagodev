import * as z from 'zod';
import { IsoDateTimeSchema, NonEmptyStringSchema, ObjectIdSchema } from './primitives.js';

/**
 * The party model (M1.2): **Account ≠ Builder ≠ Site ≠ Contact.**
 *
 * Four distinct entities, not one "customer". This is proven by production
 * data: *iPlasta Pty Ltd* is the **account** that gets invoiced; *Fowler Homes*,
 * *GJ Gardner* and *King Homes* are the **builders** whose sites are serviced.
 * Collapsing them into one field is the mistake this file exists to prevent, so
 * there is deliberately no type called `Customer` — the UI says "account" or
 * "builder" and means one of them.
 */

/** M1.1 — brand is a first-class dimension, not a setting. */
export const BRAND_IDS = ['plastago', 'easylift', 'brickgo'] as const;
export const BrandIdSchema = z.enum(BRAND_IDS).meta({ id: 'BrandId' });
export type BrandId = z.infer<typeof BrandIdSchema>;

export const BRAND_LABELS: Record<BrandId, string> = {
  plastago: 'PlastaGo',
  easylift: 'EasyLift',
  brickgo: 'BrickGo',
};

/** M6.3 — service charge and per-m² rate both vary by zone. */
export const ZONES = ['sydney', 'wollongong', 'newcastle'] as const;
export const ZoneSchema = z.enum(ZONES).meta({ id: 'Zone' });
export type Zone = z.infer<typeof ZoneSchema>;

export const ZONE_LABELS: Record<Zone, string> = {
  sydney: 'Sydney',
  wollongong: 'Wollongong',
  newcastle: 'Newcastle',
};

/**
 * M2.3 / M4.3 — per-account capture configuration.
 *
 * m² and kg are two different quantities, not two units: m² is the board
 * installed (and what gets priced), kg is the waste actually recovered. Some
 * accounts record only the first.
 */
export const CAPTURE_MODES = ['area-only', 'area-and-weight'] as const;
export const CaptureModeSchema = z.enum(CAPTURE_MODES).meta({ id: 'CaptureMode' });
export type CaptureMode = z.infer<typeof CaptureModeSchema>;

export const CAPTURE_MODE_LABELS: Record<CaptureMode, string> = {
  'area-only': 'm² only',
  'area-and-weight': 'm² and kg',
};

/** M2.10 — PO enforcement is per account. */
export const PO_POLICIES = ['not-required', 'required-before-invoice'] as const;
export const PoPolicySchema = z.enum(PO_POLICIES).meta({ id: 'PoPolicy' });
export type PoPolicy = z.infer<typeof PoPolicySchema>;

export const PO_POLICY_LABELS: Record<PoPolicy, string> = {
  'not-required': 'Not required',
  'required-before-invoice': 'Required before invoicing',
};

/** M6.1 — resolution order is named card → tier → default. */
export const RATE_CARDS = [
  'clarendon-domaine',
  'wisdom',
  'tier-1',
  'tier-2',
  'tier-3',
  'tier-4',
  'default',
] as const;
export const RateCardIdSchema = z.enum(RATE_CARDS).meta({ id: 'RateCardId' });
export type RateCardId = z.infer<typeof RateCardIdSchema>;

export const RATE_CARD_LABELS: Record<RateCardId, string> = {
  'clarendon-domaine': 'Clarendon & Domaine',
  wisdom: 'Wisdom Properties Group',
  'tier-1': 'Tier 1',
  'tier-2': 'Tier 2',
  'tier-3': 'Tier 3',
  'tier-4': 'Tier 4',
  default: 'Default Customer Rates',
};

export const ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export const AccountStatusSchema = z.enum(ACCOUNT_STATUSES).meta({ id: 'AccountStatus' });
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** M8.4 — one contact per role, each with its own channel preferences. */
export const CONTACT_ROLES = ['site', 'accounts', 'sustainability'] as const;
export const ContactRoleSchema = z.enum(CONTACT_ROLES).meta({ id: 'ContactRole' });
export type ContactRole = z.infer<typeof ContactRoleSchema>;

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
  site: 'Site',
  accounts: 'Accounts',
  sustainability: 'Sustainability',
};

export const ContactSchema = z
  .object({
    id: ObjectIdSchema,
    name: NonEmptyStringSchema,
    role: ContactRoleSchema,
    email: z.email().nullable(),
    mobile: z.string().nullable(),
    /** M8.4 — per-contact, per-channel preferences. */
    notifyBySms: z.boolean(),
    notifyByEmail: z.boolean(),
  })
  .meta({ id: 'Contact' });

/**
 * M2.9 — the site register.
 *
 * `lotNumber` is first-class because drivers get lost in greenfield estates
 * where street numbers do not exist yet; the booking form's own placeholder
 * pleads for both.
 */
export const SiteSchema = z
  .object({
    id: ObjectIdSchema,
    accountId: ObjectIdSchema,
    /** The builder on site — NOT the account being invoiced (M1.2). */
    builderName: z.string(),
    name: NonEmptyStringSchema,
    lotNumber: z.string().nullable(),
    addressLine: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    postcode: z.string(),
    zone: ZoneSchema,
    /** M3.3 — every site carries a confirmed pin. */
    latitude: z.number(),
    longitude: z.number(),
    accessNotes: z.string(),
    gateHours: z.string().nullable(),
    inductionRequired: z.boolean(),
    craneAvailable: z.boolean(),
    siteContactName: z.string().nullable(),
    siteContactMobile: z.string().nullable(),
    jobCount: z.number().int().nonnegative(),
    status: AccountStatusSchema,
  })
  .meta({ id: 'Site' });

/** Row shape for the accounts grid — enough to filter and scan, no more. */
export const AccountListItemSchema = z
  .object({
    id: ObjectIdSchema,
    code: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    status: AccountStatusSchema,
    siteCount: z.number().int().nonnegative(),
    openJobCount: z.number().int().nonnegative(),
    lastJobAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'AccountListItem' });

export const AccountSchema = AccountListItemSchema.extend({
  abn: z.string(),
  paymentTermsDays: z.number().int().positive(),
  primaryZone: ZoneSchema,
  contacts: z.array(ContactSchema),
  /** M5.6 / F46 — preferred windows and blackout times per account. */
  preferredPickupWindow: z.string().nullable(),
  notes: z.string(),
  createdAt: IsoDateTimeSchema,
}).meta({ id: 'Account' });

export type Contact = z.infer<typeof ContactSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type AccountListItem = z.infer<typeof AccountListItemSchema>;
export type Account = z.infer<typeof AccountSchema>;
