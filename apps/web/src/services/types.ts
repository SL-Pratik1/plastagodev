import type { DriverRunService } from './driver-run.types.js';
import type {
  Account,
  ChangeRequestDecision,
  ChangeRequestItem,
  AccountDraft,
  AccountListItem,
  AccountOnboarding,
  AccountType,
  AccountUpdate,
  AdditionalServiceCreate,
  AdditionalServiceSetting,
  AdditionalServiceUpdate,
  AllocationBoard,
  AwaitingCallUp,
  AwaitingPoChaseResult,
  AwaitingPoItem,
  CallUp,
  CallUpOutcome,
  CallUpRequest,
  CallUpState,
  Certificate,
  ChargeApprovalDetail,
  ChargeApprovalItem,
  ChargeDecision,
  ChargeDecisionOutcome,
  CreateRunInput,
  FutileDecision,
  FutileReview,
  FutileReviewItem,
  Lead,
  LeadAttachment,
  LeadConversion,
  LeadCreate,
  LeadListItem,
  LeadPipelineStats,
  LeadUpdate,
  PoConfirmation,
  PoExtraction,
  PoExtractionItem,
  QueueCounts,
  DashboardSummary,
  Driver,
  DriverListItem,
  DriverProfile,
  FinancialReport,
  Invoice,
  InvoiceDownloads,
  MonthlyVolumeReport,
  Notification,
  NotificationSummary,
  ReportFilters,
  Settings,
  Vehicle,
  VehicleDefectState,
  VehicleDraft,
  VehicleExpenseDraft,
  VehicleListItem,
  ZoneVolumeReport,
  ExceptionReason,
  InvoiceListItem,
  RaisedInvoice,
  Job,
  JobComment,
  JobCommentDraft,
  BookablePurchaseOrder,
  JobDraft,
  JobListItem,
  MapPin,
  OtpChallenge,
  OtpRequest,
  OtpVerify,
  PageMeta,
  PortalAccount,
  PortalAccountUpdate,
  PortalBookingDraft,
  PortalChangeRequest,
  PortalDashboard,
  PortalInvoice,
  PortalJob,
  PortalJobEdit,
  PortalJobListItem,
  PortalJobMessage,
  PortalScope,
  PortalSupervisor,
  PortalSupervisorInvite,
  Place,
  PlaceWrite,
  PricePreview,
  RateCardCreate,
  RateCardSummary,
  RateCardUpdate,
  RateScheduleCreate,
  OnboardingInvite,
  ReadinessCertification,
  Role,
  Run,
  RunSheet,
  Session,
  User,
  InvitationResult,
  InvoiceTemplate,
  InvoiceTemplateWrite,
  InvoicingSettings,
  TemplatePreview,
  InvitedUser,
  UserDraft,
  UserListItem,
  UserStatus,
  ZoneCreate,
  ZoneSummary,
  ZoneUpdate,
} from '@plastago/shared';

/**
 * Service interfaces — the seam between the UI and wherever data comes from.
 *
 * Screens depend on these interfaces and nothing else. Today they resolve to an
 * in-memory mock; later they resolve to an adapter over `@plastago/api-client`.
 * No component imports `fetch`, a URL, or the api client directly.
 *
 * ⚠️ Deliberately NO endpoint paths anywhere in this layer. The API contract
 * freezes from real UI needs (§6A.9) — inventing `/api/v1/auth/otp/request`
 * before the auth domain exists would be guessing at the contract, which is the
 * exact thing the frontend-first sequencing is designed to avoid. The method
 * signatures below ARE the requirement statement; the paths get chosen when the
 * endpoints are written, and only the adapter learns them.
 */

/** Everything a server-paginated list needs, mirroring `PageQuerySchema`. */
export interface ListQuery {
  page: number;
  pageSize: number;
  /** Field name; prefix with `-` for descending, matching `PageQuerySchema`. */
  sort?: string | undefined;
  /** Free-text search. */
  q?: string | undefined;
  /** Screen-specific facets, e.g. `{ role: 'driver', status: 'active' }`. */
  filters?: Readonly<Record<string, string | undefined>>;
}

/** Mirrors the paged envelope from `pageOf()` so the shape never diverges. */
export interface ListResult<TItem> {
  data: TItem[];
  meta: PageMeta;
}

/**
 * Authentication (§9). Email OTP and SMS OTP; no passwords anywhere.
 *
 * `getSession` returns `null` for "not signed in" rather than throwing — an
 * anonymous visitor is a normal state, not an error, and modelling it as a
 * thrown 401 makes every caller wrap it in a try/catch that swallows real
 * failures too.
 */
export interface AuthService {
  getSession: () => Promise<Session | null>;
  requestCode: (input: OtpRequest) => Promise<OtpChallenge>;
  resendCode: (challengeId: string) => Promise<OtpChallenge>;
  verifyCode: (input: OtpVerify) => Promise<Session>;
  /**
   * Change which of the user's roles is active, and get the new session back.
   *
   * Returns the session rather than `void` because the caller's next act is to
   * re-render the whole application around the answer — a second `getSession`
   * to learn what it already asked for would only add a flicker.
   *
   * Rejects with FORBIDDEN for a role the user does not hold.
   */
  setActiveRole: (role: Role) => Promise<Session>;
  signOut: () => Promise<void>;
}

/** An option for a picker or a filter dropdown. */
export interface LookupOption {
  value: string;
  label: string;
  /** Renders as an `<optgroup>` — e.g. sites grouped by suburb. */
  group?: string;
}

/**
 * Shared reference lists.
 *
 * Separate from the domain services because a filter dropdown must not have to
 * page through an entire domain to populate itself. These are small, cached
 * hard, and read by many screens.
 */
/**
 * One zone, shaped for a picker or a filter.
 *
 * ── Why this is not a plain `LookupOption` ────────────────────────────────
 * Because a zone has to answer two questions a rate card never did. A PICKER
 * must offer only the zones the office still services. A FILTER over historical
 * work must be able to name a zone that has since been retired, or the jobs grid
 * grows a filter option that matches rows it cannot label.
 *
 * One request carrying the whole register with a flag answers both; two
 * endpoints would be two caches to keep in step.
 */
export interface ZoneOption {
  /** The zone's id. What every record stores and every filter sends. */
  value: string;
  label: string;
  /** Retired: still nameable, no longer offered on new work. */
  archived: boolean;
}

export interface LookupService {
  accounts: () => Promise<LookupOption[]>;
  builders: () => Promise<LookupOption[]>;
  drivers: () => Promise<LookupOption[]>;
  /**
   * M6.1 — the rate cards, for the pickers that assign one to an account.
   *
   * ⚠️ Read from here, never from a constant. Rate cards used to be a
   * compile-time enum with a matching label map; they are records an
   * administrator creates now, so a screen holding its own list would be
   * missing every card added since the last deploy.
   */
  rateCards: () => Promise<LookupOption[]>;
  /**
   * M6.3 — the service zones.
   *
   * ⚠️ Read from here, never from a constant. Zones used to be a compile-time
   * enum with a matching label map; they are records an administrator creates
   * now, so a screen holding its own list would be missing every zone added
   * since the last deploy — and naming one would be impossible.
   */
  zones: () => Promise<ZoneOption[]>;
  /**
   * Address lookup (Matt, 7:25) — matches on suburb name or postcode.
   *
   * Returns at most a handful: this feeds a type-ahead, and a list longer than
   * the screen is a list nobody reads to the bottom of. An empty query returns
   * the whole (small) set, so the control can open with something in it.
   */
  places: (query: string) => Promise<Place[]>;
}

/** M1.5 · W1, W2, W16. */
export interface UserService {
  list: (query: ListQuery) => Promise<ListResult<UserListItem>>;
  get: (id: string) => Promise<User>;
  /**
   * Returns the new row AND what happened to their invitation — the two are
   * separate outcomes, because the account is created whether or not the
   * message got out.
   */
  create: (draft: UserDraft) => Promise<InvitedUser>;
  update: (id: string, draft: UserDraft) => Promise<UserListItem>;
  /** Activate, suspend, or re-invite. Never a hard delete — the audit trail. */
  setStatus: (id: string, status: UserStatus) => Promise<UserListItem>;
  resendInvite: (id: string) => Promise<InvitationResult>;
}

/**
 * M2.8 · W8 — accounts.
 *
 * Named `customers` because that is what the office calls them, but the type is
 * `Account`: the party that gets invoiced, distinct from the builder on site
 * (M1.2). The nested lists are separate calls so a detail page loads its header
 * immediately and fills each tab on demand.
 */
/**
 * What a create returns: the row, and what actually reached the customer.
 *
 * ⚠️ The welcome outcome is part of the RESPONSE, not an exception. A send
 * that failed is not a failed create — the account stands either way — but the
 * screen used to announce an invitation it had no way of knowing about, so the
 * office learnt nothing had gone out only when the customer rang.
 *
 * `null` means none was asked for, which is different from one that did not go.
 */
export interface CreatedAccount {
  account: AccountListItem;
  welcome: InvitationResult | null;
}

export interface CustomerService {
  list: (query: ListQuery) => Promise<ListResult<AccountListItem>>;
  get: (id: string) => Promise<Account>;
  /**
   * Create an account with no lead behind it (Matt, 6:10).
   *
   * The lead queue stays the door for enquiries; this is the door for a
   * relationship that was already negotiated — *"for the larger builders like
   * Clarendon Homes, they won't go through… we'll just create the account for
   * them."*
   */
  create: (draft: AccountDraft) => Promise<CreatedAccount>;
  /**
   * Correct an existing account's details.
   *
   * ⚠️ Not a commercial edit. The rate card, the payment terms, the PO policy
   * and the capture mode are absent from `AccountUpdate` entirely — they
   * re-price every invoice on the account and belong to a deliberate act, not
   * to the form somebody opens to fix a misspelt suburb.
   *
   * Returns the updated `Account` so the detail page renders what was actually
   * stored, including the fields the server normalised.
   */
  update: (accountId: string, input: AccountUpdate) => Promise<Account>;
  jobs: (accountId: string, query: ListQuery) => Promise<ListResult<JobListItem>>;
  invoices: (accountId: string, query: ListQuery) => Promise<ListResult<InvoiceListItem>>;

  /**
   * M4.8b — whether this builder requires a Site Risk Assessment.
   *
   * Returns the updated account rather than `void` so the screen renders the
   * server's answer, not its own optimistic guess. It matters here more than
   * usual: this switch changes what a DRIVER is made to do at a fence, and a UI
   * that shows "on" while the record says "off" is a compliance gap wearing a
   * tick.
   */
  setRiskAssessmentRequired: (accountId: string, required: boolean) => Promise<Account>;
  /**
   * M7.5 — which invoice template this account's invoices are drawn with.
   *
   * `null` means follow the brand, and it is the right answer for almost every
   * account. Resolved at render time and then frozen onto the invoice, so this
   * changes the NEXT invoice and never one already sent.
   */
  setInvoiceTemplate: (accountId: string, invoiceTemplateId: string | null) => Promise<Account>;
  /**
   * Builder or contractor — the account's journey (Matt, 21:55).
   *
   * Returns the updated account for the same reason as the switch above: this
   * decides whether the customer has site supervisors and which booking form
   * they see, so the screen must render what was stored, not what was asked for.
   * The server refuses builder → contractor while supervisors can still sign in,
   * and that refusal arrives as a 409 the caller has to show.
   */
  setAccountType: (accountId: string, accountType: AccountType) => Promise<Account>;
  /*
   * The per-site exception is gone with the sites (Matt, 0:29).
   *
   * A site could previously override its account's rule — one estate with
   * overhead powerlines demanding an assessment the rest of the account did
   * not. That override lived on the site record, and a job is now created once
   * and never revisited, so there is nowhere for a standing exception to live.
   * The account-level rule above is the only knob.
   */
}

export interface JobService {
  list: (query: ListQuery) => Promise<ListResult<JobListItem>>;
  get: (id: string) => Promise<Job>;
  /**
   * M2.1 / M6.9 — the estimate shown before saving.
   *
   * ⚠️ Server-resolved, always. Pricing is an effective-dated three-dimensional
   * lookup that must match TransVirtual to the cent (Risk 1); a second
   * implementation in the browser would be a second thing to keep correct.
   */
  preview: (draft: JobDraft) => Promise<PricePreview>;
  /**
   * M2.12 — the purchase orders this account can book a pickup against.
   *
   * The form sends only the chosen `purchaseOrderId`; the area, the bag
   * allowance and the PO number are resolved server-side from the order. These
   * rows exist so the picker can SHOW what it is choosing — a control that
   * silently changed the price would be worse than one that asked.
   */
  purchaseOrders: (accountId: string, search?: string) => Promise<BookablePurchaseOrder[]>;
  create: (draft: JobDraft) => Promise<JobListItem>;
  /** M2.4 — cancel with a structured reason, never free text. */
  cancel: (id: string, reason: ExceptionReason, note: string) => Promise<void>;
  reschedule: (id: string, readyDate: string) => Promise<void>;
  /**
   * M2.11 / M8.6 · W50, W102 — post to one of the job's three threads.
   *
   * A `driver` comment also raises a push notification (M4.11 · F45), which is
   * why this returns the created comment rather than `void`: the delivery state
   * is part of the answer, and the thread has to show it.
   */
  addComment: (jobId: string, draft: JobCommentDraft) => Promise<JobComment>;
}

/**
 * M3 — allocation and dispatch.
 *
 * No automatic assignment and no route optimisation: both are explicitly out of
 * scope, and with two drivers manual allocation is faster and more transparent.
 * `assign` therefore takes a driver the human chose.
 */
export interface DispatchService {
  board: (date: string) => Promise<AllocationBoard>;

  /* ── Building a run ───────────────────────────────────────────────────
   * The allocator shapes the day before staffing it (Matt, 44:50), so
   * creating, filling and assigning are three separate calls rather than one
   * "allocate" that does all three. A run with no driver on it is a valid,
   * saveable thing.
   */
  createRun: (input: CreateRunInput) => Promise<Run>;
  renameRun: (runId: string, name: string) => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
  /** Adds a job to the end of a run. Moving between runs is add-then-remove. */
  addJobToRun: (runId: string, jobId: string) => Promise<void>;
  removeJobFromRun: (runId: string, jobId: string) => Promise<void>;
  /** Reorder by hand. `jobIds` must be a permutation of the run's stops. */
  reorderRun: (runId: string, jobIds: readonly string[]) => Promise<void>;
  /**
   * I11 — Google Route Optimization orders the stops (Matt, 42:06).
   * Overwrites any hand-ordering, which is why the UI confirms first.
   */
  optimiseRun: (runId: string) => Promise<Run>;

  /* ── Staffing it ──────────────────────────────────────────────────────
   * A driver takes whole runs, and normally two of them in a day — morning
   * South Coast, tip off, afternoon Sydney (Matt, 40:03).
   */
  assignRun: (runId: string, driverId: string) => Promise<void>;
  unassignRun: (runId: string) => Promise<void>;

  /** One run's sheet — NOT one driver's day. See `RunSheet`. */
  runSheet: (runId: string) => Promise<RunSheet>;
  /** M3.3 — pins for visual clustering, not a computed route. */
  mapPins: (date: string) => Promise<MapPin[]>;
  drivers: () => Promise<Driver[]>;
}

/** M9.4 / F15. */
export interface DashboardService {
  summary: () => Promise<DashboardSummary>;
}

/**
 * M7 — invoicing and finance.
 *
 * The bulk operations are the documented ones and no more: M7.7 says "bulk
 * approve, bulk send", M7.6 says "PDF individually and in bulk". There is no
 * Stripe, no card capture and no credit notes — I4 was dropped by the client
 * (payment is 7-day EFT against a PO), and credit notes are v1.1.
 */
export interface InvoiceService {
  list: (query: ListQuery) => Promise<ListResult<InvoiceListItem>>;
  get: (id: string) => Promise<Invoice>;
  /**
   * M7.1 — turn a finished job's charges into an invoice.
   *
   * Returns the invoices raised: one, or two where the account needs a separate
   * purchase order for the driver's extras. The server refuses a job that is
   * not finished, one with nothing billable, and one already invoiced.
   */
  raiseForJob: (jobId: string) => Promise<RaisedInvoice[]>;
  /** Draft → sent. Returns how many actually changed. */
  send: (ids: readonly string[]) => Promise<number>;
  /** Releases an awaiting-PO invoice once its PO has been recorded (M7.3). */
  approve: (ids: readonly string[]) => Promise<number>;
  /** Records the PO number that unblocks an additional-charges invoice. */
  recordPo: (id: string, poNumber: string) => Promise<void>;
  /**
   * M7.6 — render the invoices' PDFs and get links to them.
   *
   * ⚠️ Resolves with what was actually PRODUCED, which can be fewer than were
   * asked for: an invoice whose brand has no template fails on its own. The
   * caller has to read `downloads`, not assume the request covered everything.
   *
   * The URLs are short-lived. Follow them now; never store one.
   */
  requestPdf: (ids: readonly string[]) => Promise<InvoiceDownloads>;
  /** I1 — re-push to Xero after a failure. */
  /** Resolves with what Xero actually did — `pushed: false` is a rejection, not an error. */
  retryXero: (id: string) => Promise<{ pushed: boolean; message: string | null }>;
}

/**
 * M9.1–M9.3, M9.6 and M9.5 — a fixed set of named reports.
 *
 * Every method is a specific report with parameters. There is deliberately no
 * generic `run(query)`: that is the first step toward the report builder that
 * Risk 5 names as the biggest scope trap in the project.
 */
export interface ReportService {
  monthlyVolume: (filters: ReportFilters) => Promise<MonthlyVolumeReport>;
  zoneVolume: (filters: ReportFilters) => Promise<ZoneVolumeReport>;
  financial: (filters: ReportFilters) => Promise<FinancialReport>;
  certificates: (query: ListQuery) => Promise<ListResult<Certificate>>;
  issueCertificate: (id: string) => Promise<Certificate>;
  /** A short-lived link to the stored PDF — never the storage key. */
  certificatePdf: (id: string) => Promise<{ url: string }>;
  /** Re-sends the stored document. Null where the account has no address. */
  resendCertificate: (id: string) => Promise<{ sentTo: string | null }>;
}

/** M9.8 · F53 and M9.9 · F22. */
export interface DriverService {
  list: (query: ListQuery) => Promise<ListResult<DriverListItem>>;
  get: (id: string) => Promise<DriverProfile>;
}

/** M9.7 · F43, plus the driver-reported defects from M4.9. */
export interface VehicleService {
  list: (query: ListQuery) => Promise<ListResult<VehicleListItem>>;
  get: (id: string) => Promise<Vehicle>;
  create: (draft: VehicleDraft) => Promise<VehicleListItem>;
  update: (id: string, draft: VehicleDraft) => Promise<Vehicle>;
  /**
   * In service / out of service. Never a delete — a truck that did 400 jobs
   * last year has to stay attributable, the same rule as a suspended user.
   */
  setActive: (id: string, active: boolean) => Promise<Vehicle>;
  /** `null` unassigns. The pairing is one-to-one and shows on both screens. */
  assignDriver: (id: string, driverName: string | null) => Promise<Vehicle>;
  /**
   * F43 — the input side of cost per kilometre. Returns the whole vehicle
   * because one expense moves the odometer, the totals, the cost per kilometre
   * and — when it is a service — the maintenance history with it.
   */
  addExpense: (id: string, draft: VehicleExpenseDraft) => Promise<Vehicle>;
  /**
   * open → scheduled → resolved. `scheduled` is the state the UI was missing:
   * "booked in for Thursday" is neither broken-and-ignored nor fixed.
   */
  setDefectState: (
    vehicleId: string,
    defectId: string,
    state: VehicleDefectState,
  ) => Promise<Vehicle>;
  /** W113 — the allocator's job. `null` clears the booking. */
  setNextService: (id: string, dueOn: string | null) => Promise<Vehicle>;
  /**
   * F43 — logging a renewal rolls the expiry forward by the period.
   *
   * The optional expense is why this is not two separate actions: `registration`
   * is already an expense kind, and the moment someone renews is the only moment
   * they have the amount in front of them. Making them come back later is asking
   * for a cost per kilometre that quietly understates.
   */
  renewRegistration: (id: string, expense?: VehicleExpenseDraft | null) => Promise<Vehicle>;
}

/**
 * M8.7 — the internal notification centre.
 *
 * Read state is per-user in reality; the mock keeps one set because there is one
 * demo operator. Marking read is a mutation rather than a local UI flag so it
 * survives a reload and matches what the API will do.
 */
export interface NotificationService {
  list: (query: ListQuery) => Promise<ListResult<Notification>>;
  summary: () => Promise<NotificationSummary>;
  markRead: (ids: readonly string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * W3, M1.1, M6, M7.5.
 *
 * Invoicing is the only writable section. Pricing is read-only because rates
 * are effective-dated, and the notification-rules, integrations and
 * credential-type blocks were removed — nothing downstream ever read them.
 */
export interface SettingsService {
  get: () => Promise<Settings>;
  saveInvoicing: (input: InvoicingSettings) => Promise<Settings['invoicing']>;

  /* ── The invoice logo (M7.5) ─────────────────────────────────────────── */

  /**
   * Upload a logo and put it on the invoices.
   *
   * Three steps behind one method, because the middle one does not go through
   * this API at all: ask for a ticket, PUT the bytes straight to storage, then
   * confirm. Resolves with the link to the logo now in force.
   *
   * ⚠️ Nothing changes until the confirm. An upload abandoned halfway leaves
   * the invoices printing whatever logo they had.
   */
  uploadLogo: (file: File) => Promise<string | null>;
  /** M9.5 — the signature printed on Certificates of Recycling. */
  uploadCertificateSignature: (file: File) => Promise<string | null>;
  removeCertificateSignature: () => Promise<void>;
  /** Take the logo off. Invoices fall back to the company name in text. */
  removeLogo: () => Promise<void>;

  /* ── Zones (M6.3) ────────────────────────────────────────────────────── */

  /**
   * A new service area, priced by copying one that already exists.
   *
   * ⚠️ `copyRatesFromZoneId` is required. A zone with no rates prices nothing on
   * any card, and the first sign of it is a booking form refusing to quote —
   * weeks later, on somebody else's screen.
   */
  createZone: (input: ZoneCreate) => Promise<ZoneSummary>;
  /** Renames the label. The id and slug are deliberately not reachable. */
  renameZone: (id: string, input: ZoneUpdate) => Promise<ZoneSummary>;
  /**
   * The whole list, in the order it should read.
   *
   * ⚠️ Whole-list, not one zone's position: two moves landing together would
   * otherwise leave two zones claiming the same slot.
   */
  reorderZones: (zoneIds: readonly string[]) => Promise<ZoneSummary[]>;
  /** ⚠️ RETIRES the zone. It is never deleted — historical records still need it. */
  archiveZone: (id: string) => Promise<ZoneSummary>;
  restoreZone: (id: string) => Promise<ZoneSummary>;

  /* ── Rate cards (M6.1, M6.2) ─────────────────────────────────────────── */

  createRateCard: (input: RateCardCreate) => Promise<RateCardSummary>;
  renameRateCard: (id: string, input: RateCardUpdate) => Promise<RateCardSummary>;
  /**
   * ⚠️ Issue a NEW schedule — there is deliberately no "update these rates".
   *
   * A job is priced by the rates in force on its own date, so overwriting a
   * rate would reprice work that has already been invoiced. The only safe
   * operation is adding a dated version, and it is the only one offered.
   */
  issueSchedule: (id: string, input: RateScheduleCreate) => Promise<RateCardSummary>;
  /**
   * Undo a schedule issued with the wrong start date.
   *
   * ⚠️ The server admits only a schedule that has NOT started, and never a
   * card's last one — a schedule that has priced work cannot be removed, so
   * nothing already invoiced can move.
   */
  deleteSchedule: (id: string, effectiveFrom: string) => Promise<RateCardSummary>;
  deleteRateCard: (id: string) => Promise<void>;

  /* ── Additional services (M6.5) ──────────────────────────────────────── */

  createAdditionalService: (input: AdditionalServiceCreate) => Promise<AdditionalServiceSetting>;
  updateAdditionalService: (
    code: string,
    input: AdditionalServiceUpdate,
  ) => Promise<AdditionalServiceSetting>;
  /** Refused by the server for the codes the application looks up by name. */
  deleteAdditionalService: (code: string) => Promise<void>;

  /* ── Invoice templates (M7.5) ────────────────────────────────────────── */

  createInvoiceTemplate: (input: InvoiceTemplateWrite) => Promise<InvoiceTemplate>;
  updateInvoiceTemplate: (id: string, input: InvoiceTemplateWrite) => Promise<InvoiceTemplate>;
  /** Refused while any account still invoices on it. */
  deleteInvoiceTemplate: (id: string) => Promise<void>;
  /**
   * Draw a sample invoice with this template, so it is never chosen blind.
   *
   * The figures are invented server-side — a preview of a real invoice would
   * put one customer's job and amounts in front of whoever is editing.
   */
  previewTemplate: (id: string) => Promise<TemplatePreview>;
}

/**
 * The customer portal (M5 Part 1).
 *
 * ── Not one method here takes an accountId filter ─────────────────────────
 * Every call is scoped from the SESSION, server-side. A `list({ accountId })`
 * signature would put the authorisation decision in the browser, where it can be
 * changed by editing a URL — and this is the surface where that matters most,
 * because M1.5's rule is that a site supervisor cannot see other sites or any
 * other builder's work.
 *
 * `scope()` exists so the UI knows what to *render*, not what to allow. The two
 * are different jobs and the server does the second one.
 *
 * ── Why not reuse JobService and InvoiceService ───────────────────────────
 * Because the same word means less here. A portal job carries no margin, no
 * driver comments, no internal notes and no charge provenance; a portal invoice
 * has no Xero state. Reusing the admin services would mean sending all of that
 * to a builder's phone and trusting the UI not to draw it.
 */
export interface CustomerPortalService {
  /** Resolved from the session on every page load. Cheap, cached hard. */
  scope: () => Promise<PortalScope>;

  // M5.7 · F26 — the screen that replaces phoning the office.
  dashboard: () => Promise<PortalDashboard>;

  // M5.7, M5.8, M5.9 — live status, history, and the completion record.
  jobs: (query: ListQuery) => Promise<ListResult<PortalJobListItem>>;
  job: (id: string) => Promise<PortalJob>;

  /**
   * M5.1 · F9, F21 — four fields instead of seventeen.
   *
   * ⚠️ Returns the created job so the confirmation can name its number. The
   * price estimate is a SEPARATE call and is refused for a site supervisor.
   */
  book: (draft: PortalBookingDraft) => Promise<PortalJobListItem>;
  /**
   * M6.9 — the estimate shown before booking, for roles that may see pricing.
   * Server-resolved like every other price (Risk 1).
   */
  quote: (draft: PortalBookingDraft) => Promise<PricePreview>;

  /* ── M2.12b · orders waiting for a date ─────────────────────────────── */

  /**
   * This account's confirmed orders with no job against them.
   *
   * Matt, 30:40: *"he can log into his portal and that PO that we got will be
   * sitting there on his account and he can go call this up for the 21st."*
   * Scoped from the session — no account id crosses the wire.
   */
  awaitingCallUp: (query: ListQuery) => Promise<ListResult<AwaitingCallUp>>;
  /** Name a date against one of them. Two taps, because the order has the rest. */
  callUp: (purchaseOrderId: string, request: CallUpRequest) => Promise<CallUpOutcome>;

  /** M5.4 — a direct edit, allowed only while `editable` is true. */
  editJob: (id: string, input: PortalJobEdit) => Promise<PortalJobListItem>;
  /** M5.4 — once it is on a run sheet, the change routes to the office. */
  requestChange: (id: string, input: PortalChangeRequest) => Promise<void>;
  /** M5.5 · F28 — flag urgent; the office is alerted and the board highlights it. */
  setUrgency: (id: string, urgent: boolean) => Promise<PortalJobListItem>;
  /** M5.2 · W86 — certify readiness on a job booked without it, or re-confirm. */
  certifyReadiness: (id: string, input: ReadinessCertification) => Promise<PortalJobListItem>;
  /**
   * M2.11 — reply to the office on the pickup's message thread. Always lands on
   * the job's customer thread; the server fixes that, not this call.
   */
  postMessage: (id: string, body: string) => Promise<PortalJobMessage>;

  /*
   * No site methods.
   *
   * M5.3, M5.6 and the whole sites surface are gone (Matt, 0:29): *"we don't
   * ever really visit a site more than once… the job should just have the site
   * on it as part of the details for the job."* The address is typed on the
   * booking and lives on the job.
   */

  // M5.10 · W72, W73 — Customer Administrator only.
  invoices: (query: ListQuery) => Promise<ListResult<PortalInvoice>>;
  /** Same contract as the office's — see `InvoiceService.requestPdf`. */
  requestInvoicePdf: (ids: readonly string[]) => Promise<InvoiceDownloads>;

  /** M5.11 · F1 — the report PlastaGo currently produces and sends by hand. */
  monthlyReport: (filters: ReportFilters) => Promise<MonthlyVolumeReport>;

  /** M5.12 · F52, W84 — download a Certificate of Recycling. */
  certificates: (query: ListQuery) => Promise<ListResult<Certificate>>;
  requestCertificatePdf: (id: string) => Promise<{ url: string }>;

  // M5.14 · W70 — the customer manages their own supervisors.
  supervisors: (query: ListQuery) => Promise<ListResult<PortalSupervisor>>;
  inviteSupervisor: (input: PortalSupervisorInvite) => Promise<PortalSupervisor>;
  /** Suspend or reactivate. Never a hard delete — the bookings they made stand. */
  setSupervisorState: (id: string, state: PortalSupervisor['state']) => Promise<PortalSupervisor>;
  /** B.2 — approve a join-by-customer-code on accounts that require it. */
  approveSupervisor: (id: string) => Promise<PortalSupervisor>;

  // M5.15 · F29, W71, W81.
  account: () => Promise<PortalAccount>;

  /* ── Journey A.4 — the customer completes their own account ───────────
   * Matt, 9:07: *"send them the invite for them to complete this part."* The
   * office sets the rate card and terms at conversion; the customer supplies
   * their own details and accepts the conditions, which is the director's
   * guarantee he chases on paper today (7:49).
   */
  onboardingInvite: () => Promise<OnboardingInvite>;
  completeOnboarding: (input: AccountOnboarding) => Promise<void>;
  updateAccount: (input: PortalAccountUpdate) => Promise<PortalAccount>;
}

/**
 * The five office queues — M2.6, M2.7, M7.3, M2.12 and M5 · Journey A.
 *
 * ── Why one service and not five ───────────────────────────────────────────
 * They share a lifecycle (arrives → ages → a human decides → it leaves) and a
 * single `counts()` call feeds every nav badge. Splitting them would mean five
 * near-identical adapters and five places for the ageing rule to drift.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * `recordPo` stays on `InvoiceService`. The awaiting-PO queue is a *view* over
 * invoices that already have a mutation; adding a second way to record the same
 * PO would give the backend two write paths to keep consistent.
 */
export interface QueueService {
  /** One call for every nav badge. Polled by the shell, not by each screen. */
  counts: () => Promise<QueueCounts>;

  // M2.6 — futile pickup review.
  futileList: (query: ListQuery) => Promise<ListResult<FutileReviewItem>>;
  futileGet: (id: string) => Promise<FutileReview>;
  /** Both outcomes keep the $120 fee. The decision is about the job. */
  futileDecide: (id: string, decision: FutileDecision) => Promise<void>;

  // M2.7 — additional service approvals.
  approvalList: (query: ListQuery) => Promise<ListResult<ChargeApprovalItem>>;
  approvalGet: (id: string) => Promise<ChargeApprovalDetail>;
  /** Bulk, because the queue is worked in batches. Returns how many changed. */
  approvalDecide: (
    ids: readonly string[],
    decision: ChargeDecision,
  ) => Promise<ChargeDecisionOutcome>;

  // M7.3 — approved charges awaiting a PO.
  awaitingPoList: (query: ListQuery) => Promise<ListResult<AwaitingPoItem>>;

  /**
   * M5.4 — what a customer asked for on a job already on a run sheet.
   *
   * The office end of a channel that previously had none: the portal wrote
   * these rows and nothing read them.
   */
  changeRequestList: (query: ListQuery) => Promise<ListResult<ChangeRequestItem>>;

  /** Records the answer. It does NOT move the job — see the service. */
  changeRequestDecide: (id: string, decision: ChangeRequestDecision) => Promise<void>;
  /**
   * Emails each billing contact for the PO and records the chase. Says how
   * many were emailed, so the screen never claims a send that did not happen.
   */
  awaitingPoChase: (ids: readonly string[]) => Promise<AwaitingPoChaseResult>;

  // M2.12 — AI purchase-order review.
  /* ── M2.12b · call-ups ─────────────────────────────────────────────── */

  /**
   * Orders confirmed and not yet booked — Matt's *"sitting there waiting"*
   * (21:30). The office's answer to "what have we been told about that nobody
   * has given us a date for?", which before this had no screen at all.
   */
  awaitingCallUpList: (query: ListQuery) => Promise<ListResult<AwaitingCallUp>>;
  /** Call one up by hand, for when the builder's email never arrived (30:40). */
  callUpOrder: (purchaseOrderId: string, request: CallUpRequest) => Promise<CallUpOutcome>;
  /** Call-ups that could not be applied on their own, and the applied history. */
  callUpList: (query: ListQuery & { state?: CallUpState }) => Promise<ListResult<CallUp>>;
  callUpGet: (id: string) => Promise<CallUp>;
  /**
   * Try a queued call-up again, once whatever blocked it has been fixed.
   *
   * Returns the outcome rather than void: a retry can land back in the queue for
   * a different reason, and the screen has to be able to say so.
   */
  callUpRetry: (id: string) => Promise<CallUpOutcome>;
  /** Set one aside as not actionable. The note is required. */
  callUpReject: (id: string, note: string) => Promise<void>;

  poReviewList: (query: ListQuery) => Promise<ListResult<PoExtractionItem>>;
  poReviewGet: (id: string) => Promise<PoExtraction>;
  poReviewConfirm: (id: string, input: PoConfirmation) => Promise<void>;
  poReviewReject: (id: string, note: string) => Promise<void>;

  // M5 · Journey A — leads and onboarding.
  leadList: (query: ListQuery) => Promise<ListResult<LeadListItem>>;
  /**
   * The Won / Conversion cards above the grid.
   *
   * ⚠️ Separate from `leadList` on purpose. Counting the rows the grid happens
   * to be showing is what made those cards wrong: the grid hides converted
   * leads, so "won" could only ever count leads nobody had converted.
   */
  leadStats: () => Promise<LeadPipelineStats>;
  leadGet: (id: string) => Promise<Lead>;
  /**
   * A.1 — take a lead by hand (phone, referral, walk-up).
   *
   * Returns the full `Lead` rather than a `LeadListItem` because the caller goes
   * straight to the detail screen to keep working it — handing back the list
   * shape would mean a second round trip to render the page we just navigated
   * to, and the notes thread we may have just written the first entry of.
   */
  leadCreate: (input: LeadCreate) => Promise<Lead>;
  leadUpdate: (id: string, input: LeadUpdate) => Promise<LeadListItem>;
  /**
   * Attach a PDF proposal to a lead (Matt, 5:53).
   *
   * Takes a `File` rather than a url because the browser is where the file is —
   * the adapter will multipart it, and pretending the caller already has a
   * hosted url would push that problem into every screen.
   */
  leadAttach: (leadId: string, file: File) => Promise<LeadAttachment>;
  /** Remove an attachment. Deliberately a hard delete — a wrong file is noise. */
  leadDetach: (leadId: string, attachmentId: string) => Promise<void>;

  /**
   * A.4 — creates the account and sends the welcome email.
   *
   * ⚠️ `welcome` is part of the answer, not an exception. The account stands
   * whether or not the message got out, and the screen has to be able to say
   * which of the two happened while the office can still act on it. The HTTP
   * layer has always parsed it; this type used to drop it, so the dialog
   * announced a send it had no way of knowing about.
   */
  leadConvert: (
    id: string,
    input: LeadConversion,
  ) => Promise<{ accountId: string; customerCode: string; welcome: InvitationResult | null }>;
}

export type { DriverRunService } from './driver-run.types.js';

/**
 * The container the app resolves services from.
 *
 * One service per domain. Adding a domain means adding an interface here and an
 * implementation in each adapter; screens keep importing `useServices()`.
 */
/**
 * I6 — the Extractor tab's session broker.
 *
 * One method, and it is a MUTATION rather than a read: the API creates a
 * session at a third party, and on a user's first visit provisions them into
 * the extractor tenant. Nothing about that is safe to repeat idly, which is why
 * the page calls it once on mount rather than polling it.
 */
export interface ExtractorService {
  /** A one-day session id for the iframe. Never the embed token. */
  createSession(): Promise<ExtractorSession>;
  /** Drops the cached session so the next mount mints a fresh one. */
  forgetSession(): Promise<void>;
}

export interface ExtractorSession {
  sessionId: string;
  /** ISO 8601. The page re-mints on focus rather than waiting for a failure. */
  expiresAt: string;
}

/**
 * I1 · M7.8 — the Xero connection.
 *
 * Three methods and no invoice traffic: pushing invoices happens on the server
 * when one is sent, and the sync badge already rides on the invoice itself.
 * This service exists only so an administrator can see the connection, start
 * one, and end one.
 */
export interface XeroService {
  status(): Promise<XeroConnectionStatus>;
  /**
   * Starts the handshake and returns where to send the WHOLE window.
   *
   * A mutation: it creates a single-use state row on the server, which is the
   * thing that later proves the callback answers a request we started.
   */
  beginConnect(): Promise<{ authorizeUrl: string }>;
  disconnect(): Promise<void>;
}

export interface XeroConnectionStatus {
  /** False when the deployment has no Xero credentials — the page explains. */
  configured: boolean;
  connected: boolean;
  organisationName: string | null;
  connectedByName: string | null;
  connectedAt: string | null;
  lastRefreshAt: string | null;
  /**
   * `expiring` is not a failure — it is the warning that exists because the
   * alternative is discovering a lapsed connection at month-end.
   */
  state: 'connected' | 'needs-reconnect' | 'expiring' | 'disconnected';
  message: string | null;
  refreshExpiresAt: string | null;
  /** What a pushed invoice becomes in Xero, so the page can state it plainly. */
  invoiceStatus: 'DRAFT' | 'AUTHORISED';
}

/**
 * M6.3 — the suburbs PlastaGo services.
 *
 * ── Why its own service and not a slice of `SettingsService` ──────────────
 * A settings section is part of the one `Settings` document that screen reads
 * whole, and folding this in would carry the whole suburb table on every
 * settings read, on every tab, for one screen.
 *
 * ⚠️ These rows ARE the place type-ahead behind every booking form
 * (`LookupService.places`). That lookup stays read-and-search-only; this is the
 * write side, and a write here has to invalidate it — see
 * `features/suburbs/queries.ts`.
 */
export interface SuburbService {
  /** Every suburb, archived included. The admin screen has to show both. */
  list: () => Promise<Place[]>;
  create: (draft: PlaceWrite) => Promise<Place>;
  update: (id: string, draft: PlaceWrite) => Promise<Place>;
  /**
   * ⚠️ Two outcomes behind one verb.
   *
   * A suburb nothing has ever been collected from is a typo and is REMOVED. One
   * with jobs behind it is a place the business has left, and is archived — the
   * jobs still name it, and rebooking a futile pickup there has to keep working.
   * Resolves to the archived row, or null when it was really deleted.
   */
  remove: (id: string) => Promise<Place | null>;
  restore: (id: string) => Promise<Place>;
}

export interface Services {
  readonly auth: AuthService;
  readonly lookups: LookupService;
  readonly suburbs: SuburbService;
  readonly users: UserService;
  readonly customers: CustomerService;
  readonly jobs: JobService;
  readonly dispatch: DispatchService;
  readonly dashboard: DashboardService;
  readonly invoices: InvoiceService;
  readonly reports: ReportService;
  readonly drivers: DriverService;
  readonly vehicles: VehicleService;
  readonly notifications: NotificationService;
  readonly settings: SettingsService;
  readonly extractor: ExtractorService;
  readonly xero: XeroService;
  readonly queues: QueueService;
  readonly portal: CustomerPortalService;
  /**
   * M4 — the driver surface.
   *
   * Named `driverRun`, not `driver`, because `drivers` above is the office's
   * view of the driver ROSTER (W103, W115 — performance, licences, allocation).
   * This is the driver's own view of THEIR run, and the two are different
   * enough that collapsing the names would be a standing invitation to reach
   * for the wrong one.
   */
  readonly driverRun: DriverRunService;
}
