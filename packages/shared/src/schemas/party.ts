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
 * One resolved place — a suburb with everything derived from it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Matt, 7:25: *"as you're typing in an address, it will tell you the suburbs
 * that address could be in and you can just click the suburb and it will paste
 * in the suburb, state, postcode."*
 *
 * That is the visible half. The load-bearing half is that a job cannot be
 * priced or plotted without a `zone` and a coordinate, and until now both came
 * off the site record. With sites gone (Matt, 0:29) the picker is where they
 * come from instead — one click supplies the suburb, the postcode, the zone
 * that decides the rate, and the pin the dispatch map draws.
 *
 * ⚠️ `zone` is not cosmetic. Sydney is $220 + $0.16/m², Wollongong $250 +
 * $0.18, Newcastle $250 + $0.20 (M6.3). A wrongly-zoned job is a wrongly-priced
 * invoice, and nobody notices until the customer does — which is why the zone
 * is *resolved from a chosen place* rather than typed or guessed from free text.
 *
 * ── Two backends, one shape ───────────────────────────────────────────────
 * Today this resolves against a table of the suburbs PlastaGo actually services.
 * With a billed Google key it resolves against Places Autocomplete instead. The
 * shape does not change, so neither do any of the call sites.
 */
export const PlaceSchema = z
  .object({
    /** Stable id for the place. The suburb slug today, a Google place id later. */
    id: NonEmptyStringSchema,
    suburb: NonEmptyStringSchema,
    postcode: NonEmptyStringSchema,
    state: NonEmptyStringSchema,
    /** Decides the rate. See the warning above. */
    zone: ZoneSchema,
    latitude: z.number(),
    longitude: z.number(),
    /** What the picker shows — "Kellyville NSW 2155". */
    label: NonEmptyStringSchema,
  })
  .meta({ id: 'Place' });

export type Place = z.infer<typeof PlaceSchema>;

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

/**
 * Where an account is in its onboarding, and what it may do.
 *
 * `awaiting-terms` is not a cosmetic state. Until the terms are accepted there
 * is no director's guarantee on file, which is the whole reason Matt's paper
 * form exists (7:49) — so the account can be looked at but not traded with.
 */
export const ONBOARDING_STATES = ['awaiting-terms', 'complete'] as const;
export const OnboardingStateSchema = z.enum(ONBOARDING_STATES).meta({ id: 'OnboardingState' });
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const ONBOARDING_STATE_LABELS: Record<OnboardingState, string> = {
  'awaiting-terms': 'Awaiting terms',
  complete: 'Complete',
};

/** The signed record, once accepted. Read-only everywhere after that. */
export const TermsAcceptanceSchema = z
  .object({
    acceptedAt: IsoDateTimeSchema,
    acceptedByName: NonEmptyStringSchema,
    acceptedByRole: NonEmptyStringSchema,
    /** The version accepted, so a later change to the terms is provable. */
    termsVersion: NonEmptyStringSchema,
  })
  .meta({ id: 'TermsAcceptance' });

export type TermsAcceptance = z.infer<typeof TermsAcceptanceSchema>;

/**
 * The two kinds of customer, which behave differently at almost every step.
 *
 * Matt, 21:55: *"the builders would have site supervisors… we receive the POs
 * which lists the site supervisor. But plasterer contractors, **it should be a
 * second journey**. They probably don't need it at all. They could just have one
 * login where they could create pickups."*
 *
 * ── What actually differs ─────────────────────────────────────────────────
 *
 *   | | `builder` (Domain, Clarendon) | `contractor` (iPlast, Southgate) |
 *   |—|—|—|
 *   | Purchase orders | Always, months ahead | Never (22:53) |
 *   | Site supervisors | Yes — named on the PO | Hidden (20:09) |
 *   | Booking form | Short: area and bags come off the PO (25:19) | Full: they type everything |
 *   | Sites | Pre-loaded from POs | Typed at booking (22:44) |
 *
 * This is one field rather than a set of independent toggles because the two
 * journeys move together. A contractor with site supervisors switched on but no
 * PO flow is not a customer PlastaGo has; it is a half-configured account that
 * would take a support call to explain.
 */
export const ACCOUNT_TYPES = ['builder', 'contractor'] as const;
export const AccountTypeSchema = z.enum(ACCOUNT_TYPES).meta({ id: 'AccountType' });
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  builder: 'Builder',
  contractor: 'Contractor',
};

/**
 * What each type means, in the office's own words. Shown next to the choice —
 * the labels alone do not tell a new starter which one to pick.
 */
export const ACCOUNT_TYPE_DESCRIPTIONS: Record<AccountType, string> = {
  builder: 'Sends purchase orders and call-ups. Has site supervisors who book their own pickups.',
  contractor: 'No purchase orders. One login, books pickups by filling in the form.',
};

/** Site supervisors are a builder-only concept — see `AccountTypeSchema`. */
export function hasSiteSupervisors(type: AccountType): boolean {
  return type === 'builder';
}

/**
 * True when this customer sends purchase orders.
 *
 * Drives whether the booking form asks for area and bags at all: for a builder
 * those figures come off the PO and asking would invite a contradiction
 * (Matt, 25:19). For a contractor the form IS the authorisation (22:53).
 */
export function sendsPurchaseOrders(type: AccountType): boolean {
  return type === 'builder';
}

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

/** Row shape for the accounts grid — enough to filter and scan, no more. */
export const AccountListItemSchema = z
  .object({
    id: ObjectIdSchema,
    code: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    /** Builder or contractor — see `AccountTypeSchema`. Drives both journeys. */
    accountType: AccountTypeSchema,
    /**
     * Whether the customer has accepted the terms yet (Journey A.4).
     *
     * On the LIST item rather than only the detail, because the office needs to
     * see at a glance who has not signed — an account sitting in
     * `awaiting-terms` has no director's guarantee behind it, and that is a
     * commercial exposure, not a paperwork gap.
     */
    onboardingState: OnboardingStateSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    status: AccountStatusSchema,
    openJobCount: z.number().int().nonnegative(),
    lastJobAt: IsoDateTimeSchema.nullable(),
  })
  .meta({ id: 'AccountListItem' });

/**
 * Creating an account directly, with no lead behind it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Matt, 6:10: *"we also need the ability to create customer accounts manually
 * without going through the lead and invite process. For the larger builders
 * like Clarendon Homes, they won't go through… we'll just create the account for
 * them and give them the details."*
 *
 * The lead queue exists to stop enquiries being typed straight in as jobs. It
 * was never meant to be the only door into the customer list — and for the
 * builders that matter most it is the wrong door entirely: the relationship was
 * negotiated in a meeting, not captured on a web form, and inventing a lead to
 * close it immediately is paperwork nobody reads.
 *
 * ── Same fields as a conversion, minus the lead ───────────────────────────
 * Deliberately identical to `LeadConversionSchema` in everything an account
 * needs, so the two paths cannot produce different-shaped accounts. If a field
 * belongs on one, it belongs on both.
 */
export const AccountDraftSchema = z
  .object({
    customerCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}[0-9]{3}$/, 'Three letters then three digits, e.g. NEW001'),
    legalName: z.string().trim().min(1, 'Enter the registered company name').max(120),
    abn: z
      .string()
      .trim()
      .regex(/^\d{11}$/, 'An ABN is 11 digits'),
    accountType: AccountTypeSchema,
    brandId: BrandIdSchema,
    rateCardId: RateCardIdSchema,
    poPolicy: PoPolicySchema,
    captureMode: CaptureModeSchema,
    paymentTermsDays: z.number().int().min(0).max(90),
    primaryZone: ZoneSchema,
    /** Where their invoices go. The one contact an account cannot trade without. */
    accountsContactName: z.string().trim().max(80),
    accountsContactEmail: z
      .string()
      .trim()
      .max(160)
      .refine(
        (value) => value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        'Enter a valid email address, or leave it blank',
      ),
    /**
     * Whether to email them the self-serve onboarding link.
     *
     * Off by default here, and that is the point of this form. Matt's large
     * builders *"won't go through create your own account — we'll just create the
     * account for them"* (6:36), so the office fills it in and the terms are
     * handled by whatever contract already exists.
     */
    sendInvitation: z.boolean(),
    notes: z.string().trim().max(500),
  })
  .meta({ id: 'AccountDraft' });

export type AccountDraft = z.infer<typeof AccountDraftSchema>;

export const AccountSchema = AccountListItemSchema.extend({
  /**
   * M4.8b — this builder requires a Site Risk Assessment before a driver starts.
   *
   * Lives on the ACCOUNT because it is a contractual term of theirs, not
   * something PlastaGo decides per job. Individual sites can still differ —
   * see `riskAssessmentOverride` on `Site`.
   *
   * ⚠️ Scope §Q36 is still open on whether this is ultimately per-account or
   * per-site. Modelling it as "account default + site override" answers both
   * readings without forcing the decision now, and without a migration later.
   */
  riskAssessmentRequired: z.boolean(),
  /**
   * Where this customer's diversion certificates are emailed.
   *
   * ── Three documents, three departments ────────────────────────────────
   * Matt, 31:04: *"invoices get sent off to the accounts department. Site photos
   * and site issues get sent to the site supervisor. And I need a section in
   * customers where we could say that **certificates are sent to this specific
   * email address**"* — which for most of his builders is a compliance or ESG
   * team that has nothing to do with either of the other two.
   *
   * A field rather than a fourth `Contact` row because it is a destination, not
   * a person: it is routinely a shared mailbox (esg@builder.com.au), and it must
   * survive whoever currently reads it moving on.
   *
   * Null falls back to the sustainability contact, then to accounts — a
   * certificate that goes to the wrong internal team is recoverable, one that
   * goes nowhere is not.
   */
  certificateEmail: z.string().nullable(),
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
export type AccountListItem = z.infer<typeof AccountListItemSchema>;
export type Account = z.infer<typeof AccountSchema>;
