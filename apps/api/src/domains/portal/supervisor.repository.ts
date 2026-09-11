import type { AccountType, PageMeta, PortalAccount, PortalSupervisor } from '@plastago/shared';
import mongoose from 'mongoose';
import { AccountModel, ContactModel } from '../accounts/account.model.js';
import { UserModel } from '../auth/auth.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Supervisors are USERS, not a separate table ───────────────────────────
 * A site supervisor signs in, books jobs and carries a role, so they are a user
 * with `customer-site-supervisor` and an `accountId`. A parallel "supervisors"
 * collection would mean two places a login can exist and two places to suspend
 * one — and the one you forget is the one that still works.
 */

const SUPERVISOR_ROLE = 'customer-site-supervisor';

interface RawUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string | null;
  /** Storage is Better Auth's `phoneNumber`; the contract calls it `mobile`. */
  phoneNumber: string | null;
  roles: string[];
  status: string;
  accountId: mongoose.Types.ObjectId | null;
  awaitingApproval?: boolean;
  lastSignedInAt: Date | null;
  createdAt: Date;
}

function toSupervisor(row: RawUser): PortalSupervisor {
  return {
    id: row._id.toHexString(),
    name: row.name,
    email: row.email,
    mobile: row.phoneNumber,
    /*
     * `invited` is inferred from never having signed in, rather than stored.
     * A stored flag would be a second source of truth that drifts the first
     * time somebody is activated by a path that forgets to clear it.
     */
    state:
      row.status === 'suspended'
        ? 'suspended'
        : row.lastSignedInAt === null
          ? 'invited'
          : 'active',
    invitedAt: row.createdAt.toISOString(),
    lastSignedInAt: row.lastSignedInAt ? row.lastSignedInAt.toISOString() : null,
    awaitingApproval: row.awaitingApproval ?? false,
  };
}

export const supervisorRepository = {
  /** The account's own supervisors. Scoped by `accountId`, always. */
  async list(
    accountId: string,
    query: { page: number; pageSize: number; q?: string | undefined },
  ): Promise<{ data: PortalSupervisor[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {
      accountId: new mongoose.Types.ObjectId(accountId),
      roles: SUPERVISOR_ROLE,
    };

    if (query.q) {
      const term = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
      ];
    }

    const [rows, total] = await Promise.all([
      UserModel.find(filter)
        // Awaiting approval first — those are the ones somebody has to action.
        .sort({ awaitingApproval: -1, name: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawUser[]>(),
      UserModel.countDocuments(filter),
    ]);

    return {
      data: rows.map(toSupervisor),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /**
   * How many supervisors on this account can still sign in.
   *
   * ── Why "live" and not "all" ──────────────────────────────────────────────
   * Used to decide whether an account may be moved from builder to contractor,
   * a journey with no supervisors in it. A SUSPENDED supervisor cannot sign in,
   * so they are not a reason to block the change — but their user record has to
   * stay, because a job is scoped by `bookedByUserId` and deleting them would
   * orphan every pickup they raised. Counting them would make the switch
   * permanently impossible for any account that ever had staff turnover.
   */
  async countLive(accountId: string): Promise<number> {
    if (!mongoose.isValidObjectId(accountId)) return 0;

    return UserModel.countDocuments({
      accountId: new mongoose.Types.ObjectId(accountId),
      roles: SUPERVISOR_ROLE,
      status: { $ne: 'suspended' },
    });
  },

  /** One supervisor, but only if they belong to this account. */
  async findOne(id: string, accountId: string): Promise<PortalSupervisor | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await UserModel.findOne({
      _id: new mongoose.Types.ObjectId(id),
      // The scope, in the query — an id from another account simply is not found.
      accountId: new mongoose.Types.ObjectId(accountId),
      roles: SUPERVISOR_ROLE,
    }).lean<RawUser>();

    return row ? toSupervisor(row) : null;
  },

  /** Whether this email or mobile already has a login anywhere. */
  async findExisting(input: {
    email: string | null;
    mobile: string | null;
  }): Promise<{ id: string; accountId: string | null } | null> {
    const clauses: Record<string, unknown>[] = [];
    if (input.email) clauses.push({ email: input.email.toLowerCase() });
    if (input.mobile) clauses.push({ phoneNumber: input.mobile });
    if (clauses.length === 0) return null;

    const row = await UserModel.findOne({ $or: clauses }).lean<RawUser>();
    if (!row) return null;

    return {
      id: row._id.toHexString(),
      accountId: row.accountId ? row.accountId.toHexString() : null,
    };
  },

  async invite(input: {
    accountId: string;
    name: string;
    email: string | null;
    mobile: string | null;
    awaitingApproval: boolean;
  }): Promise<string> {
    const created = await UserModel.create({
      name: input.name,
      email: input.email,
      // Better Auth signs in by `phoneNumber`, so this is the field that makes
      // an SMS invite actually work rather than look sent and never arrive.
      phoneNumber: input.mobile,
      roles: [SUPERVISOR_ROLE],
      role: SUPERVISOR_ROLE,
      status: 'active',
      accountId: new mongoose.Types.ObjectId(input.accountId),
      awaitingApproval: input.awaitingApproval,
      lastSignedInAt: null,
      brandIds: ['plastago'],
    });

    return created._id.toHexString();
  },

  /**
   * Suspends or reactivates.
   *
   * ⚠️ Never a hard delete. The bookings they made STAND — a job's
   * `bookedByUserId` is what scopes it, and removing the user would orphan
   * every job they raised, making them invisible to the supervisors who
   * replaced them.
   */
  async setState(
    id: string,
    accountId: string,
    state: 'active' | 'suspended',
  ): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await UserModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(id),
        accountId: new mongoose.Types.ObjectId(accountId),
        roles: SUPERVISOR_ROLE,
      },
      { $set: { status: state } },
    );

    return result.matchedCount === 1;
  },

  /** B.2 — approves a join-by-customer-code. */
  async approve(id: string, accountId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await UserModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(id),
        accountId: new mongoose.Types.ObjectId(accountId),
        // Only one that is actually waiting. Approving an approved user is a
        // no-op the caller should hear about rather than a silent success.
        awaitingApproval: true,
      },
      { $set: { awaitingApproval: false, status: 'active' } },
    );

    return result.matchedCount === 1;
  },
};

/* ── M5.15 · the account, as the customer sees it ────────────────────────── */

interface RawAccount {
  _id: mongoose.Types.ObjectId;
  code: string;
  name: string;
  abn: string;
  paymentTermsDays: number;
  poPolicy: PortalAccount['poPolicy'];
  captureMode: PortalAccount['captureMode'];
  primaryZone: PortalAccount['primaryZone'];
  preferredPickupWindow: string | null;
  approveNewSupervisors?: boolean;
}

export const portalAccountRepository = {
  /**
   * Just the account's type — builder or contractor.
   *
   * ── Why a one-field read and not `find()` ─────────────────────────────────
   * Every supervisor endpoint has to know this before it does anything (site
   * supervisors are a builder concept — Matt, 20:09), and `find()` joins the
   * contacts to build the whole portal account view. Paying for a join and a
   * second collection on the way to reading one enum would put the cost of a
   * screen onto a guard that runs four times as often.
   *
   * `null` means no such account, which the caller must treat as a refusal
   * rather than as "not a builder".
   */
  async accountTypeOf(accountId: string): Promise<AccountType | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;

    const row = await AccountModel.findById(accountId)
      .select('accountType')
      .lean<{ accountType: AccountType }>();

    return row?.accountType ?? null;
  },

  async find(accountId: string): Promise<PortalAccount | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;

    const row = await AccountModel.findById(accountId).lean<RawAccount>();
    if (!row) return null;

    const contacts = await ContactModel.find({ accountId: row._id }).sort({ name: 1 }).lean();

    return {
      accountId: row._id.toHexString(),
      customerCode: row.code,
      name: row.name,
      abn: row.abn,
      /*
       * Read-only in the portal. Payment terms, the PO policy and the capture
       * mode are a commercial negotiation — a customer changing their own terms
       * from 7 days to 60 is not a preference.
       */
      paymentTermsDays: row.paymentTermsDays,
      poPolicy: row.poPolicy,
      captureMode: row.captureMode,
      primaryZone: row.primaryZone,
      contacts: contacts.map((contact) => ({
        id: contact._id.toHexString(),
        name: contact.name,
        role: contact.role,
        email: contact.email ?? null,
        mobile: contact.mobile ?? null,
        notifyBySms: contact.notifyBySms,
        notifyByEmail: contact.notifyByEmail,
      })),
      preferredPickupWindow: row.preferredPickupWindow,
      approveNewSupervisors: row.approveNewSupervisors ?? false,
    };
  },

  /**
   * The preferences a customer may change about themselves.
   *
   * ⚠️ Deliberately narrow. Nothing here can alter what a job costs — the rate
   * card, the terms and the PO policy are absent, and a field that could change
   * pricing would be on the wrong form.
   */
  async update(
    accountId: string,
    input: { preferredPickupWindow: string | null; approveNewSupervisors: boolean },
  ): Promise<boolean> {
    const result = await AccountModel.updateOne(
      { _id: new mongoose.Types.ObjectId(accountId) },
      { $set: input },
    );

    return result.matchedCount === 1;
  },

  /** Notification preferences, per contact. Scoped so only own contacts move. */
  async updateContactPreferences(
    accountId: string,
    contacts: ReadonlyArray<{ id: string; notifyBySms: boolean; notifyByEmail: boolean }>,
  ): Promise<void> {
    const valid = contacts.filter((contact) => mongoose.isValidObjectId(contact.id));
    if (valid.length === 0) return;

    await ContactModel.bulkWrite(
      valid.map((contact) => ({
        updateOne: {
          filter: {
            _id: new mongoose.Types.ObjectId(contact.id),
            // The account is in the FILTER: a contact id from another customer
            // matches nothing rather than being updated.
            accountId: new mongoose.Types.ObjectId(accountId),
          },
          update: {
            $set: { notifyBySms: contact.notifyBySms, notifyByEmail: contact.notifyByEmail },
          },
        },
      })),
    );
  },

  /**
   * Journey A.4 — the registered details the CUSTOMER is the authority on.
   *
   * Separate from anything the office set at conversion. The customer knows
   * their own registered name, ABN and address; the office does not.
   */
  async completeOnboarding(
    accountId: string,
    input: {
      legalName: string;
      tradingName: string | null;
      abn: string;
      addressLine: string;
      suburb: string;
      postcode: string;
      certificateEmail: string | null;
    },
  ): Promise<boolean> {
    const result = await AccountModel.updateOne(
      { _id: new mongoose.Types.ObjectId(accountId) },
      {
        $set: {
          name: input.legalName,
          tradingName: input.tradingName,
          abn: input.abn,
          addressLine: input.addressLine,
          suburb: input.suburb,
          postcode: input.postcode,
          certificateEmail: input.certificateEmail,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /** Ensures the accounts contact the onboarding form supplies exists. */
  async upsertAccountsContact(input: {
    accountId: string;
    name: string;
    email: string;
  }): Promise<void> {
    await ContactModel.updateOne(
      { accountId: new mongoose.Types.ObjectId(input.accountId), role: 'accounts' },
      {
        $set: { name: input.name, email: input.email.toLowerCase(), notifyByEmail: true },
        $setOnInsert: {
          accountId: new mongoose.Types.ObjectId(input.accountId),
          role: 'accounts',
          notifyBySms: false,
        },
      },
      { upsert: true },
    );
  },
};
