import type {
  BrandId,
  PageMeta,
  Role,
  User,
  UserDevice,
  UserListItem,
  UserSignIn,
  UserStatus,
} from '@plastago/shared';
import mongoose from 'mongoose';
import { AccountModel } from '../accounts/account.model.js';
import { UserModel } from '../auth/auth.model.js';
import { UserDeviceModel, UserSignInModel } from './user.model.js';

/**
 * Repository layer — the ONLY file in this domain that touches Mongoose
 * (§6A.3 #5).
 *
 * ── Why the user table is shared with auth, not duplicated ────────────────
 * A user administered here is the same row that signs in. A parallel
 * "staff" collection would mean two places a login can exist and two places to
 * suspend one — and the one you forget is the one that still works.
 */

export interface ListUsersQuery {
  page: number;
  pageSize: number;
  sort?: string | undefined;
  q?: string | undefined;
  role?: Role | undefined;
  status?: UserStatus | undefined;
  brandId?: BrandId | undefined;
  account?: string | undefined;
}

export interface UpsertUserInput {
  name: string;
  email: string | null;
  mobile: string | null;
  role: Role;
  roles: Role[];
  jobTitle: string | null;
  brandIds: BrandId[];
  accountId: string | null;
  notes: string;
}

interface RawUser {
  _id: mongoose.Types.ObjectId;
  name: string;
  email: string | null;
  phoneNumber: string | null;
  role: Role;
  roles: Role[];
  status: UserStatus;
  brandIds: BrandId[];
  accountId: mongoose.Types.ObjectId | null;
  jobTitle: string | null;
  invitedBy: string | null;
  notes: string;
  lastSignedInAt: Date | null;
  createdAt: Date;
}

const SORTABLE: Record<string, string> = {
  name: 'name',
  role: 'role',
  status: 'status',
  createdAt: 'createdAt',
  lastSignedInAt: 'lastSignedInAt',
};

function toListItem(row: RawUser, accountName: string | null): UserListItem {
  return {
    id: row._id.toHexString(),
    name: row.name,
    email: row.email,
    // Storage is Better Auth's `phoneNumber`; the contract calls it `mobile`.
    mobile: row.phoneNumber,
    role: row.role,
    roles: row.roles,
    status: row.status,
    brandIds: row.brandIds,
    accountId: row.accountId ? row.accountId.toHexString() : null,
    accountName,
    lastSignedInAt: row.lastSignedInAt ? row.lastSignedInAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const userRepository = {
  async list(query: ListUsersQuery): Promise<{ data: UserListItem[]; meta: PageMeta }> {
    const filter: Record<string, unknown> = {};

    /*
     * Filters on `role`, the MAIN one, not on `roles`. A driver who also
     * allocates is listed as a driver — filtering the array would put them in
     * both lists, and the grid is how the office answers "who are our drivers".
     */
    if (query.role) filter.role = query.role;
    if (query.status) filter.status = query.status;
    if (query.brandId) filter.brandIds = query.brandId;

    if (query.account && mongoose.isValidObjectId(query.account)) {
      filter.accountId = new mongoose.Types.ObjectId(query.account);
    }

    if (query.q) {
      const term = escapeRegex(query.q);
      filter.$or = [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { phoneNumber: { $regex: term } },
      ];
    }

    const sortKey = query.sort?.replace(/^-/, '') ?? '';
    const direction: 1 | -1 = query.sort?.startsWith('-') ? -1 : 1;
    const sortField = SORTABLE[sortKey];

    const sort: Record<string, 1 | -1> = sortField ? { [sortField]: direction } : { name: 1 };

    const [rows, total] = await Promise.all([
      UserModel.find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean<RawUser[]>(),
      UserModel.countDocuments(filter),
    ]);

    const accountNames = await namesForAccounts(rows);

    return {
      data: rows.map((row) =>
        toListItem(row, row.accountId ? (accountNames.get(row.accountId.toHexString()) ?? null) : null),
      ),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
    };
  },

  /** One user, with their devices and recent sign-ins. */
  async findById(id: string): Promise<User | null> {
    if (!mongoose.isValidObjectId(id)) return null;

    const row = await UserModel.findById(id).lean<RawUser>();
    if (!row) return null;

    const [accountNames, devices, signIns] = await Promise.all([
      namesForAccounts([row]),
      UserDeviceModel.find({ userId: row._id, revokedAt: null })
        .sort({ lastSeenAt: -1 })
        .lean(),
      // Bounded: the detail screen shows a recent history, not an archive. The
      // full audit lives in the collection and is queried when somebody asks.
      UserSignInModel.find({ userId: row._id }).sort({ at: -1 }).limit(20).lean(),
    ]);

    return {
      ...toListItem(row, row.accountId ? (accountNames.get(row.accountId.toHexString()) ?? null) : null),
      jobTitle: row.jobTitle,
      invitedBy: row.invitedBy,
      notes: row.notes,
      devices: devices.map(
        (device): UserDevice => ({
          id: device._id.toHexString(),
          label: device.label,
          platform: device.platform,
          lastSeenAt: device.lastSeenAt.toISOString(),
          pendingSyncActions: device.pendingSyncActions,
          lastSyncAt: device.lastSyncAt ? device.lastSyncAt.toISOString() : null,
        }),
      ),
      recentSignIns: signIns.map(
        (signIn): UserSignIn => ({
          id: signIn._id.toHexString(),
          at: signIn.at.toISOString(),
          channel: signIn.channel,
          outcome: signIn.outcome,
          // Defaulted rather than null: the contract wants a string, and an
          // unknown device is honestly an empty one.
          device: signIn.device ?? '',
        }),
      ),
    };
  },

  /**
   * Whether this email or mobile is already somebody's login.
   *
   * `excludeId` so an edit that leaves the identifier alone does not collide
   * with itself.
   */
  async identifierTaken(input: {
    email: string | null;
    mobile: string | null;
    excludeId?: string;
  }): Promise<boolean> {
    const clauses: Record<string, unknown>[] = [];
    if (input.email) clauses.push({ email: input.email.toLowerCase() });
    if (input.mobile) clauses.push({ phoneNumber: input.mobile });
    if (clauses.length === 0) return false;

    const filter: Record<string, unknown> = { $or: clauses };
    if (input.excludeId && mongoose.isValidObjectId(input.excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(input.excludeId) };
    }

    return (await UserModel.countDocuments(filter)) > 0;
  },

  async create(input: UpsertUserInput & { invitedBy: string }): Promise<string> {
    const created = await UserModel.create({
      name: input.name,
      email: input.email,
      // Better Auth signs in by `phoneNumber`. Written under its name so an SMS
      // invite actually reaches somebody rather than looking sent.
      phoneNumber: input.mobile,
      role: input.role,
      roles: input.roles,
      /*
       * `invited`, never `active`. A user who has never signed in has not
       * proved they can be reached, and marking them active would hide the
       * invitations that silently failed.
       */
      status: 'invited',
      brandIds: input.brandIds,
      accountId: input.accountId ? new mongoose.Types.ObjectId(input.accountId) : null,
      jobTitle: input.jobTitle,
      notes: input.notes,
      invitedBy: input.invitedBy,
      lastSignedInAt: null,
    });

    return created._id.toHexString();
  },

  /**
   * Updates the editable fields.
   *
   * ⚠️ `status` is deliberately absent — it moves through `setStatus`, which is
   * a different decision with a different audit meaning. Folding it in here
   * would let a routine edit suspend somebody by accident.
   */
  async update(id: string, input: UpsertUserInput): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await UserModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: {
          name: input.name,
          email: input.email,
          phoneNumber: input.mobile,
          role: input.role,
          roles: input.roles,
          brandIds: input.brandIds,
          accountId: input.accountId ? new mongoose.Types.ObjectId(input.accountId) : null,
          jobTitle: input.jobTitle,
          notes: input.notes,
        },
      },
    );

    return result.matchedCount === 1;
  },

  /**
   * Activate, suspend or re-invite.
   *
   * ⚠️ Never a hard delete. Their name is frozen onto every job they booked,
   * every charge they approved and every certification they signed — removing
   * the row would not remove any of that, it would just make it unattributable.
   */
  async setStatus(id: string, status: UserStatus): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;

    const result = await UserModel.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status } },
    );

    return result.matchedCount === 1;
  },

  /** How many active users hold a role — the last-admin guard reads this. */
  async countActiveWithRole(role: Role, excludeId?: string): Promise<number> {
    const filter: Record<string, unknown> = { roles: role, status: 'active' };

    if (excludeId && mongoose.isValidObjectId(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }

    return UserModel.countDocuments(filter);
  },

  /* ── §9 · devices and sign-in history ──────────────────────────────────── */

  /** Records a device, or refreshes the one already on file. */
  async registerDevice(input: {
    userId: string;
    deviceKey: string;
    label: string;
    platform: 'ios' | 'android' | 'web';
    pendingSyncActions: number;
    lastSyncAt: Date | null;
  }): Promise<void> {
    await UserDeviceModel.updateOne(
      {
        userId: new mongoose.Types.ObjectId(input.userId),
        deviceKey: input.deviceKey,
      },
      {
        $set: {
          label: input.label,
          platform: input.platform,
          lastSeenAt: new Date(),
          pendingSyncActions: input.pendingSyncActions,
          lastSyncAt: input.lastSyncAt,
          // Signing in again on a revoked device un-revokes it: the revocation
          // was about the handset being lost, and it evidently is not.
          revokedAt: null,
          revokedBy: null,
        },
      },
      { upsert: true },
    );
  },

  /** Revokes a device — a flag, not a delete. See the model. */
  async revokeDevice(deviceId: string, userId: string, revokedBy: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(deviceId)) return false;

    const result = await UserDeviceModel.updateOne(
      {
        _id: new mongoose.Types.ObjectId(deviceId),
        userId: new mongoose.Types.ObjectId(userId),
        revokedAt: null,
      },
      { $set: { revokedAt: new Date(), revokedBy } },
    );

    return result.matchedCount === 1;
  },

  /**
   * Records a sign-in attempt.
   *
   * Append-only, and the identifier is masked before it gets here — see the
   * warning on the model.
   */
  async recordSignIn(input: {
    userId: string | null;
    identifierMasked: string;
    channel: 'email' | 'sms';
    outcome: UserSignIn['outcome'];
    device: string;
  }): Promise<void> {
    await UserSignInModel.create({
      userId: input.userId ? new mongoose.Types.ObjectId(input.userId) : null,
      identifierMasked: input.identifierMasked,
      at: new Date(),
      channel: input.channel,
      outcome: input.outcome,
      device: input.device,
    });
  },

  /** §6A.8 — devices whose offline queue has not drained. */
  async stuckDevices(minPending: number): Promise<
    Array<{ userId: string; label: string; pendingSyncActions: number; lastSyncAt: Date | null }>
  > {
    const rows = await UserDeviceModel.find({
      pendingSyncActions: { $gte: minPending },
      revokedAt: null,
    })
      .sort({ pendingSyncActions: -1 })
      .limit(50)
      .lean();

    return rows.map((row) => ({
      userId: row.userId.toHexString(),
      label: row.label,
      pendingSyncActions: row.pendingSyncActions,
      lastSyncAt: row.lastSyncAt ?? null,
    }));
  },
};

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Account names for a page of users, in one query.
 *
 * Only customer-role users carry an account, so this is usually a short list or
 * empty — but doing it per row would be the same N+1 either way.
 */
async function namesForAccounts(rows: RawUser[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.accountId).filter(Boolean))] as
    mongoose.Types.ObjectId[];

  if (ids.length === 0) return new Map();

  const accounts = await AccountModel.find({ _id: { $in: ids } }, { name: 1 }).lean<
    Array<{ _id: mongoose.Types.ObjectId; name: string }>
  >();

  return new Map(accounts.map((account) => [account._id.toHexString(), account.name]));
}

/** User input goes into a regex, so it is escaped. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
