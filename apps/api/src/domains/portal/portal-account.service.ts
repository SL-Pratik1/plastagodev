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
import type { InvoiceDownloads } from '@plastago/shared';
import { hasSiteSupervisors, isAustralianMobile, looksLikeEmail } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { accountRepository } from '../accounts/account.repository.js';
import { reportRepository } from '../reports/report.repository.js';
import { reportService } from '../reports/report.service.js';
import { invoiceService } from '../invoices/invoice.service.js';
import { listInvoices, ownedInvoiceIds } from './portal.repository.js';
import { portalAccountRepository, supervisorRepository } from './supervisor.repository.js';
import { supervisorProvisioning } from './supervisor-provisioning.service.js';

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
    query: { page: number; pageSize: number; status?: string | undefined; q?: string | undefined },
    caller: Caller,
  ): Promise<{ data: PortalInvoice[]; meta: PageMeta }> {
    const accountId = assertAdministrator(caller);
    return listInvoices(accountId, query);
  },

  /**
   * M5.10 — the customer's own invoices, as files they can open.
   *
   * ── Why this delegates rather than rendering here ─────────────────────────
   * ⚠️ This method used to write a log line and return a count. Nothing was
   * rendered and no link came back, so the portal's "Download PDFs" button was
   * a no-op a customer could press all day. Rendering is `invoiceService`'s job
   * and it now hands back links, so the fix is to actually call it.
   *
   * ── The two gates, and why both are needed ────────────────────────────────
   * `ownedInvoiceIds` first, because it filters to the statuses a customer may
   * SEE — a draft of their own invoice is still not theirs to read. The invoice
   * service then applies its own account scope on top. Delegating without the
   * first gate would let an administrator who knew an id render a draft that
   * the portal list deliberately withholds.
   */
  async requestInvoicePdf(ids: readonly string[], caller: Caller): Promise<InvoiceDownloads> {
    const accountId = assertAdministrator(caller);

    if (ids.length === 0) throw AppError.validation('Select at least one invoice');

    // Filtered through ownership, so a pasted id from another customer produces
    // a 404 rather than a rendered PDF.
    const owned = await ownedInvoiceIds(accountId, ids);
    if (owned.length === 0) throw AppError.notFound('None of those invoices could be found');

    const result = await invoiceService.requestPdf(owned, caller);

    log.info(
      { count: result.downloads.length, of: owned.length, accountId, by: caller.name },
      'customer downloaded invoice PDFs',
    );
    return result;
  },

  /* ── M5.14 · site supervisors ──────────────────────────────────────────── */

  async supervisors(
    query: { page: number; pageSize: number; q?: string | undefined },
    caller: Caller,
  ): Promise<{ data: PortalSupervisor[]; meta: PageMeta }> {
    const accountId = await assertBuilderAdministrator(caller);
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
  async inviteSupervisor(input: PortalSupervisorInvite, caller: Caller): Promise<PortalSupervisor> {
    const accountId = await assertBuilderAdministrator(caller);

    const email = input.email.trim().toLowerCase() || null;
    const mobile = input.mobile.trim() || null;

    if (!email && !mobile) {
      throw AppError.validation('Give a mobile or an email', [
        { path: 'mobile', message: 'A mobile is usually faster on site' },
      ]);
    }

    /*
     * ⚠️ The SHAPE of each, checked here as well as on the contract.
     *
     * A supervisor signs in by their `phoneNumber`, so a landline or a typo is
     * a login that can never be used — while the administrator is told "We have
     * texted them a link". The invite dialog checked both shapes and nothing
     * behind it did, so `mobile: "hello"` created a real user.
     *
     * Beside the check above rather than only on the schema, because that is
     * where the "one of the two is required" rule already lives, and because a
     * guard that only runs in the HTTP layer is one an internal caller walks
     * straight past.
     */
    if (mobile && !isAustralianMobile(mobile)) {
      throw AppError.validation('That is not an Australian mobile', [
        {
          path: 'mobile',
          message: 'Enter an Australian mobile, e.g. 0412 345 678 — that is how they sign in',
        },
      ]);
    }

    if (email && !looksLikeEmail(email)) {
      throw AppError.validation('That does not look like an email address', [
        { path: 'email', message: 'Check it — the invitation is sent to this address' },
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

    /*
     * ⚠️ Actually send it.
     *
     * The portal told the administrator "We have texted them a link — nothing to
     * install", and nothing was sent: this method created the user row and
     * stopped. The invited supervisor was never contacted, and the builder had
     * no way to tell — the row showed as "invited" either way.
     *
     * The office path has done this correctly all along (a purchase order that
     * names a supervisor provisions and notifies them), so this is the same
     * call, not a new mechanism. It is keyed on the user, so a re-invite cannot
     * text somebody who already has their access.
     *
     * `notify` swallows its own failures deliberately: a login that exists but
     * whose SMS bounced is recoverable by resending, whereas throwing here
     * would leave the supervisor created and the caller told it failed.
     */
    await supervisorProvisioning.notify({
      userId: id,
      name: supervisor.name,
      email: supervisor.email,
      mobile: supervisor.mobile,
      provisionedBy: caller.name,
      sourceLabel: 'portal invite',
    });

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
    const accountId = await assertBuilderAdministrator(caller);

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
    const accountId = await assertBuilderAdministrator(caller);

    const approved = await supervisorRepository.approve(id, accountId);

    if (!approved) {
      /*
       * ⚠️ Two different failures, and they must not share a message.
       *
       * `approve` is scoped by account, so it returns false both for somebody
       * already approved HERE and for an id belonging to another builder. It
       * answered both with "they may already have been approved" — which, sent
       * to a rival builder probing ids, confirms that the person exists and
       * describes their state. Suspending the same id already answered 404.
       */
      const onThisAccount = await supervisorRepository.findOne(id, accountId);
      if (!onThisAccount) throw AppError.notFound('No such supervisor on your account');

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

  /* ── The customer completes their own details ──────────────────────────── */

  /**
   * What the details screen opens on.
   *
   * ⚠️ Returns what is already on file, not just a suggested name. Nothing
   * gates this form any more, so a customer correcting one line of their
   * address can reach it again — and a form that arrives blank on the second
   * visit is how a complete record gets replaced with a half-filled one.
   */
  async onboardingInvite(caller: Caller): Promise<OnboardingInvite> {
    const accountId = assertAdministrator(caller);

    const account = await accountRepository.findById(accountId, { accountId });
    if (!account) throw AppError.forbidden('Your customer account could not be found');

    const accounts = account.contacts.find((contact) => contact.role === 'accounts');

    return {
      accountId: account.id,
      customerCode: account.code,
      // What the office typed at conversion. The customer may correct it — they
      // are the authority on their own registered name.
      suggestedLegalName: account.name,
      accountType: account.accountType,
      completedAt: account.detailsCompletedAt,
      details: {
        tradingName: account.tradingName,
        abn: account.abn,
        addressLine: account.addressLine,
        suburb: account.suburb,
        postcode: account.postcode,
        accountsContactName: accounts?.name ?? null,
        accountsContactEmail: accounts?.email ?? null,
        certificateEmail: account.certificateEmail,
      },
    };
  },

  /**
   * The customer supplies their own registered details.
   *
   * ── Why the customer fills this in and not the office ─────────────────────
   * Because they are the authority on it. A registered address, a trading name,
   * the ABN that prints on every invoice and the mailbox their diversion
   * certificates go to are all things the office would otherwise get by ringing
   * up and asking, and getting wrong in the meantime.
   *
   * ⚠️ RE-SUBMITTABLE, unlike the version that came before it. This used to
   * refuse a second submission, because it also recorded a terms acceptance and
   * a guarantee that can be silently replaced is not evidence of anything. The
   * terms are gone (see `party.ts`), and what is left is ordinary correctable
   * data — refusing a customer who has moved office would be refusing the one
   * person who knows their new address.
   */
  async completeOnboarding(input: AccountOnboarding, caller: Caller): Promise<void> {
    const accountId = assertAdministrator(caller);

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

    log.info({ accountId }, 'customer completed their own account details');
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

/**
 * An administrator on a BUILDER account, or a refusal.
 *
 * ── Why the account type is a server check and not a hidden menu ───────────
 * Site supervisors are a builder concept: a contractor gets one login, no
 * supervisors, and a booking form that asks for everything, because that form IS
 * the authorisation (Matt, 21:55 · 22:53). The portal already hides the menu item
 * for them — but hiding a screen is a courtesy to the user, not a boundary, and
 * `/portal/supervisors` typed into the address bar reached a working page that
 * could mint logins on a journey with no supervisors in it.
 *
 * So the refusal lives here, beside the role check, and every one of the four
 * supervisor endpoints goes through it.
 */
async function assertBuilderAdministrator(caller: Caller): Promise<string> {
  const accountId = assertAdministrator(caller);

  const accountType = await portalAccountRepository.accountTypeOf(accountId);

  // Unknown is a refusal, not a pass. A customer session pointing at an account
  // that no longer exists is broken, and the safe direction to fail is closed.
  if (accountType === null) {
    throw AppError.forbidden('Your customer account could not be found');
  }

  // The shared helper, not an inline `=== 'builder'`: the rule that supervisors
  // are a builder concept is stated once, beside the enum it reads.
  if (!hasSiteSupervisors(accountType)) {
    throw AppError.forbidden(
      'Site supervisors are for builder accounts. Your login books pickups directly.',
    );
  }

  return accountId;
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
    query: { page: number; pageSize: number; q?: string | undefined },
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

    log.info(
      { certificateId: id, accountId, by: caller.name },
      'customer requested a certificate PDF',
    );
    return { queued: 1 };
  },
};
