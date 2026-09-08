import type {
  AccountOnboarding,
  Certificate,
  OnboardingInvite,
  PageMeta,
  PortalAccount,
  PortalAccountUpdate,
  PortalInvoice,
  PortalSupervisor,
  PortalSupervisorInvite,
  Role,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { accountRepository } from '../accounts/account.repository.js';
import { TERMS_VERSION } from '../accounts/account.service.js';
import { reportRepository } from '../reports/report.repository.js';
import { reportService } from '../reports/report.service.js';
import { listInvoices, ownedInvoiceIds } from './portal.repository.js';
import { portalAccountRepository, supervisorRepository } from './supervisor.repository.js';

const log = logger.child({ module: 'portal-account' });

/**
 * The customer's own account (M5.10, M5.14, M5.15 and Journey A.4).
 *
 * ── The line this file draws ──────────────────────────────────────────────
 * A customer manages the things they are the AUTHORITY on: their registered
 * details, who from their business may book, and where notifications go. They
 * do not manage anything commercial — the rate card, the payment terms and the
 * PO policy are a negotiation with the office, and a customer changing their own
 * terms from 7 days to 60 is not a preference.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
  accountId: string | null;
}

const CUSTOMER_ADMIN: Role = 'customer-administrator';
const SITE_SUPERVISOR: Role = 'customer-site-supervisor';

export const portalAccountService = {
  /* ── M5.10 · invoices ──────────────────────────────────────────────────── */

  /**
   * The customer's own invoices.
   *
   * ⚠️ Administrator only (M1.5). A site supervisor books pickups; what the
   * business is billed is not their business, and the refusal is here rather
   * than a filtered list, so nothing leaks through a count or a total.
   */
  async invoices(
    query: { page: number; pageSize: number; status?: string | undefined },
    caller: Caller,
  ): Promise<{ data: PortalInvoice[]; meta: PageMeta }> {
    const accountId = assertAdministrator(caller);
    return listInvoices(accountId, query);
  },

  /** M5.10 — queue PDFs for invoices this account actually owns. */
  async requestInvoicePdf(ids: readonly string[], caller: Caller): Promise<{ queued: number }> {
    const accountId = assertAdministrator(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    // Filtered through ownership, so a pasted id from another customer produces
    // a 404 rather than a rendered PDF.
    const owned = await ownedInvoiceIds(accountId, ids);
    if (owned.length === 0) throw AppError.notFound('None of those invoices could be found');

    log.info(
      { count: owned.length, accountId, by: caller.name },
      'customer requested invoice PDFs',
    );
    return { queued: owned.length };
  },

  /* ── M5.14 · site supervisors ──────────────────────────────────────────── */

  async supervisors(
    query: { page: number; pageSize: number; q?: string | undefined },
    caller: Caller,
  ): Promise<{ data: PortalSupervisor[]; meta: PageMeta }> {
    const accountId = assertAdministrator(caller);
    return supervisorRepository.list(accountId, query);
  },

  /**
   * M5.14 — invite a supervisor.
   *
   * ── Why a mobile is enough, and often better ──────────────────────────────
   * The primary channel for a site supervisor is SMS (§9): many use a personal
   * Gmail address or have no work email at all. Requiring an email would exclude
   * the exact population this screen exists to serve.
   */
  async inviteSupervisor(
    input: PortalSupervisorInvite,
    caller: Caller,
  ): Promise<PortalSupervisor> {
    const accountId = assertAdministrator(caller);

    const email = input.email.trim().toLowerCase() || null;
    const mobile = input.mobile.trim() || null;

    if (!email && !mobile) {
      throw AppError.validation('Give a mobile or an email', [
        { path: 'mobile', message: 'A mobile is usually faster on site' },
      ]);
    }

    /*
     * A login belongs to a PERSON, not to an account. Somebody who already has
     * one — a supervisor who moved between builders, or an office user — cannot
     * be silently re-created: the second row would collide on the unique index,
     * and the failure would surface as a database error rather than something a
     * human can act on.
     */
    const existing = await supervisorRepository.findExisting({ email, mobile });
    if (existing) {
      throw AppError.conflict(
        existing.accountId === accountId
          ? 'That person already has a login on this account'
          : 'That email or mobile already has a PlastaGo login. Contact us on 1300 395 438.',
      );
    }

    const id = await supervisorRepository.invite({
      accountId,
      name: input.name.trim(),
      email,
      mobile,
      /*
       * Inviting somebody IS the approval. `approveNewSupervisors` gates people
       * who join by CUSTOMER CODE (B.2) — a different door, where nobody
       * vouched for them.
       */
      awaitingApproval: false,
    });

    const supervisor = await supervisorRepository.findOne(id, accountId);
    if (!supervisor) throw new Error('Supervisor vanished immediately after being invited');

    log.info({ supervisorId: id, accountId, by: caller.name }, 'site supervisor invited');
    return supervisor;
  },

  /**
   * Suspend or reactivate.
   *
   * ⚠️ Never a hard delete. The bookings they made stand — a job is scoped by
   * `bookedByUserId`, so removing the user would orphan every job they raised
   * and make it invisible to whoever replaced them.
   */
  async setSupervisorState(
    id: string,
    state: PortalSupervisor['state'],
    caller: Caller,
  ): Promise<PortalSupervisor> {
    const accountId = assertAdministrator(caller);

    if (state === 'invited') {
      /*
       * `invited` is DERIVED from never having signed in, not something anybody
       * sets. Offering it as a target would let a real login be pushed back into
       * a state its own history contradicts.
       */
      throw AppError.badRequest('A supervisor can only be made active or suspended');
    }

    if (id === caller.userId) {
      throw AppError.conflict('You cannot suspend your own login');
    }

    const changed = await supervisorRepository.setState(id, accountId, state);
    if (!changed) throw AppError.notFound('No such supervisor on your account');

    const supervisor = await supervisorRepository.findOne(id, accountId);
    if (!supervisor) throw AppError.notFound('No such supervisor on your account');

    log.info({ supervisorId: id, state, accountId, by: caller.name }, 'supervisor state changed');
    return supervisor;
  },

  /** B.2 — approve somebody who joined using the customer code. */
  async approveSupervisor(id: string, caller: Caller): Promise<PortalSupervisor> {
    const accountId = assertAdministrator(caller);

    const approved = await supervisorRepository.approve(id, accountId);
    if (!approved) {
      throw AppError.conflict(
        'That request is no longer waiting — they may already have been approved',
      );
    }

    const supervisor = await supervisorRepository.findOne(id, accountId);
    if (!supervisor) throw AppError.notFound('No such supervisor on your account');

    log.info({ supervisorId: id, accountId, by: caller.name }, 'supervisor approved');
    return supervisor;
  },

  /* ── M5.15 · the account ───────────────────────────────────────────────── */

  async account(caller: Caller): Promise<PortalAccount> {
    const accountId = assertAdministrator(caller);

    const account = await portalAccountRepository.find(accountId);
    if (!account) throw AppError.forbidden('Your customer account could not be found');

    return account;
  },

  /**
   * The preferences a customer may change about themselves.
   *
   * ⚠️ Deliberately narrow. Nothing reachable here can alter what a job costs —
   * if a field on this form could change pricing, it is on the wrong form.
   */
  async updateAccount(input: PortalAccountUpdate, caller: Caller): Promise<PortalAccount> {
    const accountId = assertAdministrator(caller);

    await portalAccountRepository.update(accountId, {
      preferredPickupWindow: input.preferredPickupWindow.trim() || null,
      approveNewSupervisors: input.approveNewSupervisors,
    });

    // Contact ids are filtered through the account in the query, so one pasted
    // from another customer updates nothing.
    await portalAccountRepository.updateContactPreferences(accountId, input.contacts);

    log.info({ accountId, by: caller.name }, 'customer updated their account preferences');

    const account = await portalAccountRepository.find(accountId);
    if (!account) throw AppError.forbidden('Your customer account could not be found');

    return account;
  },

  /* ── Journey A.4 · the customer completes their own account ────────────── */

  /** What the welcome screen needs before anything is filled in. */
  async onboardingInvite(caller: Caller): Promise<OnboardingInvite> {
    const accountId = assertAdministrator(caller);

    const account = await accountRepository.findById(accountId, { accountId });
    if (!account) throw AppError.forbidden('Your customer account could not be found');

    const acceptance = await accountRepository.findTermsAcceptance(accountId);

    return {
      accountId: account.id,
      customerCode: account.code,
      // What the office typed at conversion. The customer may correct it — they
      // are the authority on their own registered name.
      suggestedLegalName: account.name,
      accountType: account.accountType,
      // The two states this screen distinguishes: the terms are outstanding, or
      // they are signed. Nothing in between, because nothing in between changes
      // what the customer has to do.
      state: acceptance ? 'complete' : 'awaiting-terms',
      acceptance,
      termsVersion: TERMS_VERSION,
    };
  },

  /**
   * Journey A.4 — the customer supplies their own details and accepts the terms.
   *
   * ── Why this exists at all ────────────────────────────────────────────────
   * Matt has a paper account application his customers fill in today, and it is
   * there for a legal reason. 7:49: *"it's a contractual thing where some
   * customers require them to give a director's guarantee… it's more of a legal
   * precedent that they have to sign off on those account terms and
   * conditions."* This is that form, and the tick is the record he currently
   * chases as a signed PDF.
   *
   * ⚠️ The acceptance names the person who ACCEPTED, typed by them — not the
   * session user. A director's guarantee is given by a named individual, and the
   * person logged in may be an accounts clerk acting on their behalf. Taking it
   * from the session would make who signed an inference from whose password was
   * used.
   */
  async completeOnboarding(input: AccountOnboarding, caller: Caller): Promise<void> {
    const accountId = assertAdministrator(caller);

    const existing = await accountRepository.findTermsAcceptance(accountId);
    if (existing) {
      throw AppError.conflict(
        `These terms were already accepted by ${existing.acceptedByName}. Contact us on 1300 395 438 to change anything.`,
      );
    }

    await portalAccountRepository.completeOnboarding(accountId, {
      legalName: input.legalName,
      tradingName: input.tradingName.trim() || null,
      abn: input.abn,
      addressLine: input.addressLine,
      suburb: input.suburb,
      postcode: input.postcode,
      // Matt, 31:04 — certificates often go to a different team from invoices.
      certificateEmail: input.certificateEmail.trim().toLowerCase() || null,
    });

    await portalAccountRepository.upsertAccountsContact({
      accountId,
      name: input.accountsContactName,
      email: input.accountsContactEmail,
    });

    /*
     * The acceptance is written LAST and cannot overwrite an existing one.
     * Everything above is correctable by the office; this is the legal record,
     * and a second write would silently replace who signed and when.
     */
    const recorded = await accountRepository.recordTermsAcceptance({
      accountId,
      acceptedByName: input.acceptedByName,
      acceptedByRole: input.acceptedByRole,
      termsVersion: TERMS_VERSION,
    });

    if (!recorded) {
      throw AppError.conflict('These terms were accepted by somebody else while you were filling this in');
    }

    log.info(
      {
        accountId,
        acceptedBy: input.acceptedByName,
        role: input.acceptedByRole,
        termsVersion: TERMS_VERSION,
      },
      'customer completed onboarding and accepted the terms',
    );
  },
};

/* ── Access ──────────────────────────────────────────────────────────────── */

/**
 * The caller's account id, or a refusal.
 *
 * ⚠️ Administrator only. Everything in this file is money, people or legal
 * terms — a site supervisor books pickups and sees the jobs they raised, and
 * none of this is theirs to see or change (M1.5).
 */
function assertAdministrator(caller: Caller): string {
  if (!caller.accountId) {
    throw AppError.forbidden('Your login is not linked to a customer account');
  }

  const isSupervisorOnly =
    caller.roles.includes(SITE_SUPERVISOR) && !caller.roles.includes(CUSTOMER_ADMIN);

  if (isSupervisorOnly) {
    throw AppError.forbidden('Ask your account administrator — this is not shown on your login');
  }

  if (!caller.roles.includes(CUSTOMER_ADMIN)) {
    throw AppError.forbidden('This is for customer administrators');
  }

  return caller.accountId;
}

/* ── M5.12 · F52 · diversion certificates ────────────────────────────────── */

/**
 * The customer's own Certificates of Recycling.
 *
 * ── Why this waited for the reporting domain ──────────────────────────────
 * Certificates are ISSUED by reporting (M9.5), against the reconciled
 * weighbridge tonnage. Building a portal screen before anything produced them
 * would have been a list that was permanently empty.
 *
 * ⚠️ Only ISSUED ones. A draft is a figure the office has not stood behind yet,
 * and a customer downloading one would put an unconfirmed tonnage into a Green
 * Star submission.
 */
export const portalCertificateService = {
  async certificates(
    query: { page: number; pageSize: number },
    caller: Caller,
  ): Promise<{ data: Certificate[]; meta: PageMeta }> {
    const accountId = assertAdministrator(caller);

    return reportService.certificates(
      { ...query, state: 'issued' },
      {
        userId: caller.userId,
        name: caller.name,
        roles: caller.roles,
        // Scoped in the repository by this, so the list can only ever be theirs.
        accountId,
      },
    );
  },

  /** Queues the PDF for one of their own certificates. */
  async requestCertificatePdf(id: string, caller: Caller): Promise<{ queued: number }> {
    const accountId = assertAdministrator(caller);

    const certificate = await reportRepository.findCertificate(id, accountId);
    // 404, not 403 — a 403 confirms another customer's certificate exists.
    if (!certificate) throw AppError.notFound('No such certificate');

    if (certificate.state !== 'issued') {
      throw AppError.conflict('That certificate has not been issued yet');
    }

    log.info({ certificateId: id, accountId, by: caller.name }, 'customer requested a certificate PDF');
    return { queued: 1 };
  },
};
