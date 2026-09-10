import type {
  InvitationResult,
  InvitedUser,
  PageMeta,
  Role,
  User,
  UserDraft,
  UserListItem,
  UserStatus,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { buildInviteEmail, buildInviteSms } from '../../integrations/notice-messages.js';
import { accountRepository } from '../accounts/account.repository.js';
import { outboundService } from '../notifications/outbound.service.js';
import { userRepository, type ListUsersQuery } from './user.repository.js';

const log = logger.child({ module: 'users' });

/**
 * User administration (M1.5).
 *
 * ── The three rules this file exists to enforce ───────────────────────────
 * 1. Nobody can lock everybody out. The last active super-admin cannot be
 *    suspended or demoted, because the recovery for that is a database console.
 * 2. A user is never deleted. Their name is frozen onto every job they booked
 *    and every charge they approved; removing the row makes that unattributable
 *    rather than removing it.
 * 3. A customer role must carry an account, and an office role must not. The
 *    account is what scopes the portal, so a supervisor without one sees
 *    nothing and a supervisor with the wrong one sees somebody else's work.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

/** Who may administer users at all. */
const ADMIN_ROLES = new Set<Role>(['super-admin', 'operations']);

/** The roles whose scope IS a customer account. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

const SUPER_ADMIN: Role = 'super-admin';

export const userService = {
  async list(
    query: ListUsersQuery,
    caller: Caller,
  ): Promise<{ data: UserListItem[]; meta: PageMeta }> {
    assertAdmin(caller);
    return userRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<User> {
    assertAdmin(caller);

    const user = await userRepository.findById(id);
    if (!user) throw AppError.notFound('No such user');

    return user;
  },

  /**
   * Invites a user.
   *
   * They are created `invited`, never `active`: somebody who has never signed
   * in has not proved they can be reached, and an active-looking row hides the
   * invitations that silently failed.
   */
  async create(draft: UserDraft, caller: Caller): Promise<InvitedUser> {
    assertAdmin(caller);

    const normalised = await normalise(draft, caller);

    if (await userRepository.identifierTaken({ email: normalised.email, mobile: normalised.mobile })) {
      throw AppError.conflict(
        'That email or mobile already belongs to somebody. A person has one login.',
      );
    }

    const id = await userRepository.create({ ...normalised, invitedBy: caller.name });

    const created = await userRepository.findById(id);
    if (!created) throw new Error('User vanished immediately after being created');

    /*
     * The invitation itself.
     *
     * ⚠️ Unable to throw. The account that exists is the durable outcome; the
     * message is the best-effort part, and the office is told which it got so
     * they can fall back to the phone. Sending first — or letting a provider
     * error escape — would mean a mail outage silently stopped anybody being
     * onboarded.
     */
    const invitation = await sendInvitation(created, caller.name);

    log.info(
      {
        userId: id,
        role: draft.role,
        invitedBy: caller.name,
        invitation: invitation.outcome,
        channel: invitation.channel,
      },
      'user invited',
    );

    return { user: created, invitation };
  },

  /**
   * Edits a user.
   *
   * ⚠️ `status` is not reachable from here — it moves through `setStatus`,
   * which is a different decision with a different audit meaning. Folding them
   * together would let a routine edit suspend somebody by accident.
   */
  async update(id: string, draft: UserDraft, caller: Caller): Promise<UserListItem> {
    assertAdmin(caller);

    const existing = await userRepository.findById(id);
    if (!existing) throw AppError.notFound('No such user');

    const normalised = await normalise(draft, caller);

    if (
      await userRepository.identifierTaken({
        email: normalised.email,
        mobile: normalised.mobile,
        excludeId: id,
      })
    ) {
      throw AppError.conflict('That email or mobile already belongs to somebody else');
    }

    /*
     * ⚠️ The last-admin guard, on the ROLE path.
     *
     * Demoting the only remaining super-admin locks everybody out of user
     * administration, and the recovery is a database console. Checked against
     * the ACTIVE population, excluding this user, because they are the one
     * losing the role.
     */
    if (existing.roles.includes(SUPER_ADMIN) && !normalised.roles.includes(SUPER_ADMIN)) {
      await assertNotLastAdmin(id, 'demote');
    }

    const changed = await userRepository.update(id, normalised);
    if (!changed) throw AppError.notFound('No such user');

    const updated = await userRepository.findById(id);
    if (!updated) throw AppError.notFound('No such user');

    log.info({ userId: id, by: caller.name }, 'user updated');
    return updated;
  },

  /**
   * Activate, suspend or re-invite.
   *
   * ⚠️ Never a hard delete. See the note at the top of this file — the row is
   * what makes their past work attributable.
   */
  async setStatus(id: string, status: UserStatus, caller: Caller): Promise<UserListItem> {
    assertAdmin(caller);

    const existing = await userRepository.findById(id);
    if (!existing) throw AppError.notFound('No such user');

    if (id === caller.userId && status !== 'active') {
      // Suspending yourself is always a mistake, and it is one nobody else can
      // undo without another administrator.
      throw AppError.conflict('You cannot suspend your own login');
    }

    // The last-admin guard again, on the STATUS path.
    if (status !== 'active' && existing.roles.includes(SUPER_ADMIN)) {
      await assertNotLastAdmin(id, 'suspend');
    }

    if (existing.status === status) {
      // Nothing to do, and saying so beats a success that changed nothing.
      throw AppError.conflict(`${existing.name} is already ${status}`);
    }

    const changed = await userRepository.setStatus(id, status);
    if (!changed) throw AppError.notFound('No such user');

    const updated = await userRepository.findById(id);
    if (!updated) throw AppError.notFound('No such user');

    log.info({ userId: id, status, by: caller.name }, 'user status changed');
    return updated;
  },

  /**
   * Re-sends an invitation.
   *
   * Only to somebody who has not signed in. Re-inviting an active user would
   * send them a sign-in link they did not ask for, which is indistinguishable
   * from a phishing attempt from their point of view.
   */
  async resendInvite(id: string, caller: Caller): Promise<InvitationResult> {
    assertAdmin(caller);

    const user = await userRepository.findById(id);
    if (!user) throw AppError.notFound('No such user');

    if (user.status === 'suspended') {
      throw AppError.conflict(`${user.name} is suspended — reactivate them first`);
    }

    if (user.lastSignedInAt !== null) {
      throw AppError.conflict(
        `${user.name} has already signed in — they can request a code from the sign-in screen`,
      );
    }

    if (!user.email && !user.mobile) {
      throw AppError.conflict(`${user.name} has no email or mobile to send an invitation to`);
    }

    /*
     * `force`, because a person clicking Resend has already decided the first
     * attempt did not land — the once-only guard exists to stop a sweep sending
     * twice, not to overrule the office.
     *
     * `invitedBy` falls back to whoever is resending: the original inviter may
     * have left, and an invitation signed by nobody reads like a scam.
     */
    const result = await sendInvitation(user, user.invitedBy ?? caller.name, { force: true });

    log.info(
      { userId: id, channel: result.channel, outcome: result.outcome, by: caller.name },
      'invitation re-sent',
    );

    return result;
  },
};

/* ── The invitation ──────────────────────────────────────────────────────── */

/**
 * Sends somebody their way in.
 *
 * ── Why the channel is not simply "their role's channel" ───────────────────
 * `ROLE_PRIMARY_CHANNEL` says how a role SIGNS IN, which is a different
 * question from how this person can be REACHED. An office administrator with
 * only a mobile on file still has to be told, and a driver who happens to have
 * an email is cheaper to reach that way — SMS costs money per message. So the
 * decision is made from the contact details that actually exist, by
 * `outboundService`, and this function only supplies both forms of the message.
 */
async function sendInvitation(
  user: Pick<UserListItem, 'id' | 'name' | 'email' | 'mobile' | 'role'>,
  invitedBy: string,
  options: { force?: boolean } = {},
): Promise<InvitationResult> {
  /*
   * The identifier is spelled out in the message because it is the ONLY one
   * that will receive a code — see `notice-messages.ts`. Email wins here for
   * the same reason it wins in the channel choice.
   */
  const identifier = user.email ?? user.mobile ?? '';

  const context = { name: user.name, invitedBy, role: user.role, identifier };

  const result = await outboundService.send({
    event: 'user-invite',
    subjectKey: `user-invite:${user.id}`,
    recipient: { email: user.email, mobile: user.mobile },
    email: (to) => buildInviteEmail(to, context),
    sms: (to) => buildInviteSms(to, { ...context, identifier: to }),
    force: options.force,
  });

  return result;
}

/* ── Validation ──────────────────────────────────────────────────────────── */

/**
 * Normalises a draft and refuses the combinations that would break scoping.
 *
 * Everything here is a rule the database cannot express: which roles need an
 * account, which identifier a role can actually be reached by, and who is
 * allowed to hand out `super-admin`.
 */
async function normalise(draft: UserDraft, caller: Caller) {
  const email = draft.email.trim().toLowerCase() || null;
  const mobile = draft.mobile.trim() || null;

  if (!email && !mobile) {
    throw AppError.validation('Give an email or a mobile', [
      { path: 'email', message: 'One of the two is needed — it is how they sign in' },
    ]);
  }

  // `role` is the main one; `roles` always contains it. Deduplicated so a
  // caller listing it twice does not produce a user with two identical roles.
  const roles = [...new Set<Role>([draft.role, ...draft.additionalRoles])];

  const isCustomerRole = roles.some((role) => CUSTOMER_ROLES.has(role));

  /*
   * ⚠️ A customer role without an account sees nothing, and a customer role
   * with the WRONG account sees somebody else's work. Both are refused here
   * because the portal's whole boundary is this field.
   */
  if (isCustomerRole && !draft.accountId) {
    throw AppError.validation('A customer login needs an account', [
      { path: 'accountId', message: 'Choose the customer account this person belongs to' },
    ]);
  }

  if (!isCustomerRole && draft.accountId) {
    throw AppError.validation('An office or driver login does not belong to one account', [
      { path: 'accountId', message: 'Leave this empty for internal roles' },
    ]);
  }

  if (draft.accountId) {
    const account = await accountRepository.findById(draft.accountId, { accountId: null });
    if (!account) {
      throw AppError.validation('That account could not be found', [
        { path: 'accountId', message: 'Choose an account from the list' },
      ]);
    }
  }

  /*
   * Mixing a customer role with an internal one would give somebody both a
   * scoped portal view and an unscoped office view, and the office view wins
   * everywhere — so the account silently stops meaning anything.
   */
  if (isCustomerRole && roles.some((role) => !CUSTOMER_ROLES.has(role))) {
    throw AppError.validation('A login is either internal or a customer login', [
      { path: 'additionalRoles', message: 'Customer roles cannot be combined with office roles' },
    ]);
  }

  /*
   * Only a super-admin may create another. Operations administers users, but
   * handing out the role that can remove your own is a different power.
   */
  if (roles.includes(SUPER_ADMIN) && !caller.roles.includes(SUPER_ADMIN)) {
    throw AppError.forbidden('Only a super-admin can grant super-admin');
  }

  return {
    name: draft.name.trim(),
    email,
    mobile,
    role: draft.role,
    roles,
    jobTitle: draft.jobTitle.trim() || null,
    brandIds: draft.brandIds,
    accountId: draft.accountId,
    notes: draft.notes.trim(),
  };
}

/**
 * Refuses to leave the system with no way in.
 *
 * ⚠️ Counted against ACTIVE super-admins excluding this user. Suspending or
 * demoting the last one locks everybody out of user administration, and the
 * only recovery is somebody editing the database by hand.
 */
async function assertNotLastAdmin(userId: string, action: 'suspend' | 'demote'): Promise<void> {
  const remaining = await userRepository.countActiveWithRole(SUPER_ADMIN, userId);

  if (remaining === 0) {
    throw AppError.conflict(
      `This is the only active super-admin — make somebody else one before you ${action} them`,
    );
  }
}

function assertAdmin(caller: Caller): void {
  if (!caller.roles.some((role) => ADMIN_ROLES.has(role))) {
    throw AppError.forbidden('User administration is for operations and super-admins');
  }
}
