import type {
  Account,
  AccountListItem,
  AccountStatus,
  AccountType,
  BrandId,
  CaptureMode,
  Contact,
  ContactRole,
  OnboardingState,
  PageMeta,
  PoPolicy,
  RateCardId,
  TermsAcceptance,
  Zone,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { withTransaction } from '../../lib/transaction.js';
import { AccountModel, ContactModel, TermsAcceptanceModel } from './account.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * It owns two things besides queries:
 *
 *  1. **The storage ↔ contract translation.** `_id` becomes `id`, `Date`
 *     becomes an ISO string, `Decimal128` becomes a decimal string. No Mongo
 *     type escapes this file, so the service is testable without a database.
 *
 *  2. **Row-level scoping.** A customer-role caller may only ever see their own
 *     account, and that constraint is applied to the QUERY here rather than
 *     filtered afterwards in a controller (§6A.3 #5). A filter someone can
 *     forget to apply is not a boundary.
 */

/**
 * The filter this repository builds.
 *
 * Declared rather than using Mongoose's `FilterQuery`, which v9 no longer
 * exports as a namespace member. Narrow on purpose: every key here is one this
 * file sets, so a typo in a facet name is a compile error rather than a filter
 * that silently matches everything.
 */
interface AccountFilter {
  _id?: mongoose.Types.ObjectId;
  status?: AccountStatus;
  accountType?: AccountType;
  brandId?: BrandId;
  rateCardId?: RateCardId;
  poPolicy?: PoPolicy;
  captureMode?: CaptureMode;
  $text?: { $search: string };
  /** Derived constraints that must survive alongside the scope clause. */
  $and?: Array<{ _id: { $in: mongoose.Types.ObjectId[] } | { $nin: mongoose.Types.ObjectId[] } }>;
}

/** Who is asking. Enough to scope a query, and nothing more. */
export interface AccountScope {
  /** Null for office and admin roles — they legitimately see every account. */
  accountId: string | null;
}

export interface ListAccountsQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  status?: AccountStatus | undefined;
  accountType?: AccountType | undefined;
  brandId?: BrandId | undefined;
  rateCardId?: RateCardId | undefined;
  poPolicy?: PoPolicy | undefined;
  captureMode?: CaptureMode | undefined;
  onboarding?: OnboardingState | undefined;
}

export interface CreateAccountInput {
  code: string;
  name: string;
  accountType: AccountType;
  brandId: BrandId;
  rateCardId: RateCardId;
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  abn: string;
  paymentTermsDays: number;
  primaryZone: Zone;
  notes: string;
  contact: { name: string; email: string | null } | null;
  /** Terms agreed off-system — written in the same transaction when set. */
  termsAgreedOffSystem: { termsVersion: string } | null;
}

/** Shape of a `.lean()` account document. */
interface RawAccount {
  _id: mongoose.Types.ObjectId;
  code: string;
  name: string;
  accountType: AccountType;
  brandId: BrandId;
  rateCardId: RateCardId;
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  status: AccountStatus;
  abn: string;
  paymentTermsDays: number;
  primaryZone: Zone;
  riskAssessmentRequired: boolean;
  certificateEmail: string | null;
  preferredPickupWindow: string | null;
  notes: string;
  /** From `timestamps: true`. Present on every document Mongoose writes. */
  createdAt: Date;
}

interface RawContact {
  _id: mongoose.Types.ObjectId;
  accountId: mongoose.Types.ObjectId;
  name: string;
  role: ContactRole;
  email: string | null;
  mobile: string | null;
  notifyBySms: boolean;
  notifyByEmail: boolean;
}

interface RawTerms {
  accountId: mongoose.Types.ObjectId;
  acceptedAt: Date;
  acceptedByName: string;
  acceptedByRole: string;
  termsVersion: string;
}

/**
 * Sort fields a caller may name.
 *
 * An allow-list, not a pass-through: `sort` arrives from a querystring, and
 * handing an arbitrary string to Mongo lets a caller sort by any field in the
 * document — including ones the projection deliberately withholds.
 */
const SORTABLE: Record<string, string> = {
  name: 'name',
  code: 'code',
  status: 'status',
  accountType: 'accountType',
  createdAt: 'createdAt',
};

export const accountRepository = {
  /**
   * The accounts grid.
   *
   * `openJobCount` and `lastJobAt` are on the contract but come from the jobs
   * collection, which does not exist yet. They are returned as 0/null until the
   * jobs domain lands, at which point this becomes a `$lookup` — see the note
   * on `toListItem`.
   */
  async list(
    query: ListAccountsQuery,
    scope: AccountScope,
  ): Promise<{ data: AccountListItem[]; meta: PageMeta }> {
    const filter = await buildFilter(query, scope);

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    // Typed as the literal union rather than `number`, so the sort object below
    // needs no assertion to satisfy it.
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    /*
     * A text search orders by relevance unless the caller asked otherwise.
     * Falling back to `name` gives a stable, alphabetical grid — Mongo's
     * natural order is not an order anyone can predict.
     */
    const sort: Record<string, 1 | -1 | { $meta: 'textScore' }> = sortField
      ? { [sortField]: direction }
      : query.q
        ? { score: { $meta: 'textScore' } }
        : { name: 1 };

    const projection = query.q && !sortField ? { score: { $meta: 'textScore' } } : {};

    const [rows, total] = await Promise.all([
      AccountModel.find(filter, projection)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawAccount[]>(),
      AccountModel.countDocuments(filter),
    ]);

    /*
     * Onboarding state is derived from the terms collection, fetched in ONE
     * query for the whole page rather than one per row — the classic N+1 that
     * makes a 20-row grid issue 21 queries.
     */
    const signed = await signedAccountIds(rows.map((row) => row._id));

    return {
      data: rows.map((row) => toListItem(row, signed.has(row._id.toHexString()))),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One account, with its contacts. Null when it does not exist or is out of scope. */
  async findById(id: string, scope: AccountScope): Promise<Account | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    // Scoping applied to the QUERY: a customer asking for another account's id
    // gets "not found", which is also the correct answer to give them.
    if (scope.accountId !== null && scope.accountId !== id) return null;

    const account = await AccountModel.findById(id).lean<RawAccount>();
    if (!account) return null;

    const [contacts, terms] = await Promise.all([
      ContactModel.find({ accountId: account._id }).sort({ role: 1, name: 1 }).lean<RawContact[]>(),
      TermsAcceptanceModel.findOne({ accountId: account._id }).lean<RawTerms>(),
    ]);

    return {
      ...toListItem(account, terms !== null),
      riskAssessmentRequired: account.riskAssessmentRequired,
      certificateEmail: resolveCertificateEmail(account, contacts),
      abn: account.abn,
      paymentTermsDays: account.paymentTermsDays,
      primaryZone: account.primaryZone,
      contacts: contacts.map(toContact),
      preferredPickupWindow: account.preferredPickupWindow,
      notes: account.notes,
      createdAt: account.createdAt.toISOString(),
    };
  },

  /** True when the code is already taken. Used before an insert, for a clear error. */
  async codeExists(code: string): Promise<boolean> {
    const existing = await AccountModel.exists({ code: code.trim().toUpperCase() });
    return existing !== null;
  },

  /**
   * Create the account, its first contact and (optionally) its terms row.
   *
   * ── One transaction, three collections ───────────────────────────────────
   * Reference-based modelling means a "create account" is a multi-document
   * write, so it needs a transaction (§6A.3 #3). Without one, a crash between
   * the account insert and the contact insert leaves an account whose invoices
   * have nowhere to go — and nothing in the data says it is broken.
   */
  async create(input: CreateAccountInput): Promise<AccountListItem> {
    /*
     * The account is written FIRST, deliberately.
     *
     * On a standalone deployment `withTransaction` runs these sequentially, and
     * a failure part-way leaves what has already committed. An account with no
     * contact is a visible record the office can complete by hand; a contact
     * with no account is an orphan nobody can see. Parent first, compensate by
     * removing it — see `lib/transaction.ts`.
     */
    let accountId: mongoose.Types.ObjectId | null = null;

    return withTransaction(
      async (session) => {
        const options = session ? { session } : {};

        const [account] = await AccountModel.create(
          [
            {
              code: input.code.trim().toUpperCase(),
              name: input.name,
              accountType: input.accountType,
              brandId: input.brandId,
              rateCardId: input.rateCardId,
              poPolicy: input.poPolicy,
              captureMode: input.captureMode,
              status: 'active',
              abn: input.abn,
              paymentTermsDays: input.paymentTermsDays,
              primaryZone: input.primaryZone,
              // Off by default: the account rule is a builder's contractual
              // demand, not a PlastaGo policy. Defaulting it on would make
              // every driver on a new account fill in an unrequested form.
              riskAssessmentRequired: false,
              certificateEmail: null,
              preferredPickupWindow: null,
              notes: input.notes,
            },
          ],
          options,
        );

        if (!account) throw new Error('Account insert returned no document');
        accountId = account._id;

        if (input.contact) {
          await ContactModel.create(
            [
              {
                accountId: account._id,
                name: input.contact.name,
                role: 'accounts',
                email: input.contact.email,
                mobile: null,
                // Only opt them into email if there is an address to send to.
                notifyBySms: false,
                notifyByEmail: input.contact.email !== null,
              },
            ],
            options,
          );
        }

        if (input.termsAgreedOffSystem) {
          await TermsAcceptanceModel.create(
            [
              {
                accountId: account._id,
                acceptedAt: new Date(),
                acceptedByName: 'Agreed off-system',
                acceptedByRole: 'Existing contract',
                termsVersion: input.termsAgreedOffSystem.termsVersion,
              },
            ],
            options,
          );
        }

        return toListItem(
          account.toObject<RawAccount>(),
          input.termsAgreedOffSystem !== null,
        );
      },
      {
        label: 'accounts.create',
        // Only ever runs on the degraded path. Removes the parent and anything
        // that did land under it, so a retry with the same code is not blocked
        // by a half-written account holding the unique index.
        compensate: async () => {
          if (!accountId) return;
          await Promise.all([
            ContactModel.deleteMany({ accountId }),
            TermsAcceptanceModel.deleteMany({ accountId }),
            AccountModel.deleteOne({ _id: accountId }),
          ]);
        },
      },
    );
  },

  /**
   * M4.8b — the account's risk-assessment rule.
   *
   * A targeted `$set`, not a document save: the account is written by more than
   * one flow and a whole-document write would clobber whatever else changed.
   */
  async setRiskAssessmentRequired(id: string, required: boolean): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await AccountModel.updateOne(
      { _id: id },
      { $set: { riskAssessmentRequired: required } },
    );
    return result.matchedCount > 0;
  },

  /** Journey A.4 — the signed record. Null while outstanding. */
  async findTermsAcceptance(accountId: string): Promise<TermsAcceptance | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;
    const terms = await TermsAcceptanceModel.findOne({ accountId }).lean<RawTerms>();
    if (!terms) return null;

    return {
      acceptedAt: terms.acceptedAt.toISOString(),
      acceptedByName: terms.acceptedByName,
      acceptedByRole: terms.acceptedByRole,
      termsVersion: terms.termsVersion,
    };
  },

  /**
   * Journey A.4 — records the customer accepting the terms.
   *
   * ── Why this is an insert that can fail, not an upsert ────────────────────
   * The acceptance is the record Matt currently chases as a signed PDF (7:49) —
   * a director's guarantee, given once by a named individual. Overwriting it
   * would silently replace who signed and when, which is the one thing the
   * record exists to prove. The unique index on `accountId` makes a second
   * acceptance impossible; this returns false so the caller can say so.
   */
  async recordTermsAcceptance(input: {
    accountId: string;
    acceptedByName: string;
    acceptedByRole: string;
    termsVersion: string;
  }): Promise<boolean> {
    if (!mongoose.isValidObjectId(input.accountId)) return false;

    const result = await TermsAcceptanceModel.updateOne(
      { accountId: new mongoose.Types.ObjectId(input.accountId) },
      {
        $setOnInsert: {
          accountId: new mongoose.Types.ObjectId(input.accountId),
          acceptedAt: new Date(),
          acceptedByName: input.acceptedByName,
          acceptedByRole: input.acceptedByRole,
          termsVersion: input.termsVersion,
        },
      },
      { upsert: true },
    );

    // `upsertedCount` is 1 only when this call created it. An existing
    // acceptance matches and changes nothing, which is the correct outcome and
    // a false return.
    return result.upsertedCount === 1;
  },
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

async function buildFilter(
  query: ListAccountsQuery,
  scope: AccountScope,
): Promise<AccountFilter> {
  const filter: AccountFilter = {};

  /*
   * The scoping clause, first and unconditional.
   *
   * A customer-role caller is narrowed to their own account here. Everything
   * below is a user-supplied facet and can only narrow further — there is no
   * combination of query parameters that widens this.
   */
  if (scope.accountId !== null) filter._id = new mongoose.Types.ObjectId(scope.accountId);

  if (query.status) filter.status = query.status;
  if (query.accountType) filter.accountType = query.accountType;
  if (query.brandId) filter.brandId = query.brandId;
  if (query.rateCardId) filter.rateCardId = query.rateCardId;
  if (query.poPolicy) filter.poPolicy = query.poPolicy;
  if (query.captureMode) filter.captureMode = query.captureMode;
  if (query.q) filter.$text = { $search: query.q };

  /*
   * Onboarding is DERIVED from the terms collection, so filtering on it means
   * resolving that set first rather than matching a column.
   *
   * ⚠️ This filter previously did nothing at all: the facet was accepted by the
   * schema, passed through, and never applied — so "show me who has not signed"
   * silently returned everybody. A filter that quietly matches everything is
   * worse than one that errors, because the office reads the result as an
   * answer.
   *
   * Combined with the scope clause rather than overwriting it: a customer
   * asking for `awaiting-terms` must still only ever see their own account.
   */
  if (query.onboarding) {
    const signed = await TermsAcceptanceModel.find({})
      .select({ accountId: 1 })
      .lean<{ accountId: mongoose.Types.ObjectId }[]>();
    const ids = signed.map((row) => row.accountId);

    /*
     * `$and` at the top level, not a second `_id` key.
     *
     * Assigning `_id` twice would silently drop the scope clause — the later
     * write wins — and a customer would see every unsigned account on the
     * platform. Both constraints have to survive, so they are ANDed.
     */
    const clause = query.onboarding === 'complete' ? { $in: ids } : { $nin: ids };
    filter.$and = [...(filter.$and ?? []), { _id: clause }];
  }

  return filter;
}

/** One query for a whole page's onboarding state. See the note in `list`. */
async function signedAccountIds(ids: mongoose.Types.ObjectId[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await TermsAcceptanceModel.find({ accountId: { $in: ids } })
    .select({ accountId: 1 })
    .lean<{ accountId: mongoose.Types.ObjectId }[]>();
  return new Set(rows.map((row) => row.accountId.toHexString()));
}

/**
 * Storage → contract.
 *
 * ⚠️ `openJobCount` and `lastJobAt` are placeholders until the jobs domain
 * exists. They are 0 and null rather than omitted because the contract requires
 * them and the grid renders them — a missing field would blank the column, and
 * an invented number would be worse.
 */
function toListItem(account: RawAccount, signed: boolean): AccountListItem {
  return {
    id: account._id.toHexString(),
    code: account.code,
    name: account.name,
    brandId: account.brandId,
    rateCardId: account.rateCardId,
    accountType: account.accountType,
    // Derived, never stored twice — there is no flag that could disagree.
    onboardingState: signed ? 'complete' : 'awaiting-terms',
    poPolicy: account.poPolicy,
    captureMode: account.captureMode,
    status: account.status,
    openJobCount: 0,
    lastJobAt: null,
  };
}

function toContact(contact: RawContact): Contact {
  return {
    id: contact._id.toHexString(),
    name: contact.name,
    role: contact.role,
    email: contact.email,
    mobile: contact.mobile,
    notifyBySms: contact.notifyBySms,
    notifyByEmail: contact.notifyByEmail,
  };
}

/**
 * Where certificates go, with a deliberate fallback chain.
 *
 * Explicit setting → sustainability contact → accounts contact → null.
 *
 * Matt, 31:04 asked for the explicit field. The fallbacks exist because a
 * certificate reaching the wrong internal team is recoverable, and one that
 * goes nowhere is not.
 */
function resolveCertificateEmail(account: RawAccount, contacts: RawContact[]): string | null {
  if (account.certificateEmail) return account.certificateEmail;
  const sustainability = contacts.find((c) => c.role === 'sustainability' && c.email);
  if (sustainability?.email) return sustainability.email;
  const accounts = contacts.find((c) => c.role === 'accounts' && c.email);
  return accounts?.email ?? null;
}
