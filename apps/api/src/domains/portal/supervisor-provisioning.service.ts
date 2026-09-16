import type { Role } from '@plastago/shared';
import { logger } from '../../lib/logger.js';
import { buildInviteEmail, buildInviteSms } from '../../integrations/notice-messages.js';
import { outboundService } from '../notifications/outbound.service.js';
import { supervisorRepository } from './supervisor.repository.js';

const log = logger.child({ module: 'supervisor-provisioning' });

const SITE_SUPERVISOR: Role = 'customer-site-supervisor';

/**
 * Giving a site supervisor a login because a purchase order named them (M5.14).
 *
 * ── Why this is not `portalAccountService.inviteSupervisor` ───────────────
 * That one is a builder administrator adding somebody deliberately: it demands
 * a portal caller, and it REFUSES a person who already has a login. Both are
 * right for a form and wrong here. A purchase order arrives from the office
 * side with no portal session behind it, and the same supervisor appears on
 * every order they raise — so "they already exist" is the common case, not a
 * conflict to report.
 *
 * ── What Matt asked for ───────────────────────────────────────────────────
 * 33:25: *"on here you can see the site supervisor's name is already here and
 * their phone number, so it should automatically create that supervisor
 * underneath that builder."* And on how they get in, 33:43: *"I don't think
 * they need invite to the system per se, like if they're on a purchase order,
 * they're able to access it."*
 *
 * So there is no invitation to accept and nothing to approve. The login exists
 * because the builder put their name on an order, and they are told it exists.
 */

export type ProvisionOutcome =
  /** A login was created and the person was told about it. */
  | { status: 'created'; userId: string }
  /** They already had a login on this account — reused, and not re-notified. */
  | { status: 'reused'; userId: string }
  /** Nobody was named on the order. Matt, 34:52: *"sometimes they're blank."* */
  | { status: 'not-named' }
  /** Named, but with no mobile and no email — nothing to reach them on. */
  | { status: 'no-contact' }
  /** That mobile or email is already somebody's login on another account. */
  | { status: 'belongs-elsewhere'; userId: string };

export const supervisorProvisioning = {
  /**
   * Ensures the person a document named has a login on this account.
   *
   * ⚠️ Never throws for a business reason. Every outcome a real purchase order
   * can produce is a status, because the caller is confirming a purchase order
   * and that must not fail over who is on site — Matt, 34:52: *"then it just
   * sits there with no site supervisor assigned and we can handle that
   * manually."*
   */
  async ensureForAccount(input: {
    accountId: string;
    /** Whether this account has supervisors at all. Contractors do not. */
    accountType: 'builder' | 'contractor';
    name: string | null;
    mobile: string | null;
    email?: string | null;
    /** Named on the invitation, so the message is credible. */
    provisionedBy: string;
    /** What named them, for the log — a PO number reads better than an id. */
    sourceLabel: string;
  }): Promise<ProvisionOutcome> {
    /*
     * A contractor is a different journey: they book their own work and have no
     * site supervisors to give logins to. Provisioning one would put a role on
     * an account whose portal has nowhere to use it.
     */
    if (input.accountType !== 'builder') {
      return { status: 'not-named' };
    }

    const name = input.name?.trim() ?? '';
    if (name === '') return { status: 'not-named' };

    const email = input.email?.trim().toLowerCase() || null;
    const mobile = input.mobile?.trim() || null;

    /*
     * No way to reach them means no way to sign in: a code is sent to the
     * identifier the login was created against, so a login with neither can
     * never be used. Better to leave the order unassigned and visibly so.
     */
    if (!email && !mobile) {
      log.info(
        { accountId: input.accountId, source: input.sourceLabel, name },
        'purchase order named a supervisor with no mobile or email — not provisioned',
      );
      return { status: 'no-contact' };
    }

    const existing = await supervisorRepository.findExisting({ email, mobile });

    if (existing) {
      /*
       * Already on this account. The overwhelmingly common case — a supervisor
       * appears on every order they raise — so it is silent: no second login,
       * and no second invitation to somebody who has been using theirs for
       * months.
       */
      if (existing.accountId === input.accountId) {
        return { status: 'reused', userId: existing.id };
      }

      /*
       * ⚠️ Somebody else's login. A login belongs to a PERSON: this is either a
       * supervisor who moved between builders, or an office user whose mobile
       * was typed onto an order. Moving them would hand one builder's account to
       * another builder's contact, so nothing is touched and the office is told.
       */
      log.warn(
        {
          accountId: input.accountId,
          source: input.sourceLabel,
          name,
          existingUserId: existing.id,
          existingAccountId: existing.accountId,
        },
        'supervisor on a purchase order already has a login on another account — left alone',
      );
      return { status: 'belongs-elsewhere', userId: existing.id };
    }

    const userId = await supervisorRepository.invite({
      accountId: input.accountId,
      name,
      email,
      mobile,
      /*
       * The builder named them on their own purchase order, which IS the
       * vouching. `approveNewSupervisors` gates people who arrive by customer
       * code (B.2), where nobody has.
       */
      awaitingApproval: false,
    });

    /*
     * Told, not invited. Swallowed on failure — see `quietly` below. A login
     * that exists but whose SMS bounced is recoverable by resending; a purchase
     * order rolled back because ClickSend was down is not.
     */
    await this.notify({
      userId,
      name,
      email,
      mobile,
      provisionedBy: input.provisionedBy,
      sourceLabel: input.sourceLabel,
    });

    log.info(
      { accountId: input.accountId, source: input.sourceLabel, userId, name, viaSms: !email },
      'site supervisor provisioned from a purchase order',
    );

    return { status: 'created', userId };
  },

  /**
   * "Your access is ready", by whichever channel exists.
   *
   * ── Why SMS is not a fallback but the norm ────────────────────────────────
   * §9 makes supervisors SMS-first, and Matt confirmed it at 34:16: *"In the
   * case of phone number, we have to SMS them."* Many use a personal address or
   * have no work email, so `outboundService` picks from what is actually there
   * rather than preferring email and hoping.
   */
  async notify(input: {
    userId: string;
    name: string;
    email: string | null;
    mobile: string | null;
    provisionedBy: string;
    sourceLabel: string;
  }): Promise<void> {
    const identifier = input.email ?? input.mobile ?? '';
    const context = {
      name: input.name,
      invitedBy: input.provisionedBy,
      role: SITE_SUPERVISOR,
      identifier,
    };

    try {
      await outboundService.send({
        event: 'user-invite',
        /*
         * ⚠️ Keyed on the USER, matching `user.service`'s own invitations. A
         * replayed confirmation, or a second order naming the same person,
         * must not text somebody who already has their access.
         */
        subjectKey: `user-invite:${input.userId}`,
        recipient: { email: input.email, mobile: input.mobile },
        email: (to) => buildInviteEmail(to, context),
        // The SMS identifier is the number it lands on, so it names itself.
        sms: (to) => buildInviteSms(to, { ...context, identifier: to }),
      });
    } catch (error) {
      log.error(
        { userId: input.userId, source: input.sourceLabel, err: error },
        'could not tell a provisioned supervisor about their access — login still created',
      );
    }
  },
};
