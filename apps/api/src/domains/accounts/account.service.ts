import type {
  Account,
  AccountDraft,
  AccountListItem,
  PageMeta,
  Role,
  TermsAcceptance,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import {
  accountRepository,
  type AccountScope,
  type ListAccountsQuery,
} from './account.repository.js';

/**
 * The terms wording currently in force.
 *
 * Stored on every acceptance so a later change to the terms is provable — "they
 * agreed to *this* version on *that* date" is the whole point of keeping the
 * record. Bump it when the wording changes; never rewrite existing rows.
 */
export const TERMS_VERSION = '2026-02';

/** The roles whose view is narrowed to their own account. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

/** What the caller is, as the service needs it. */
export interface Caller {
  roles: readonly Role[];
  /** Set for the two customer roles; null for office and admin. */
  accountId: string | null;
}

/**
 * Service layer — business rules. No Express, no Mongoose.
 *
 * The rules here are the ones that would otherwise be reimplemented slightly
 * differently in the browser and on the server: what makes a code valid, when
 * an account counts as onboarded, and who may see whose account.
 */
export const accountService = {
  async list(
    query: ListAccountsQuery,
    caller: Caller,
  ): Promise<{ data: AccountListItem[]; meta: PageMeta }> {
    return accountRepository.list(query, scopeFor(caller));
  },

  /**
   * One account.
   *
   * ⚠️ Out-of-scope reads return NOT_FOUND, not FORBIDDEN. A 403 confirms the
   * account exists, which tells a customer something about another customer —
   * "no such account" is both safer and true from where they are standing.
   */
  async get(id: string, caller: Caller): Promise<Account> {
    const account = await accountRepository.findById(id, scopeFor(caller));
    if (!account) throw AppError.notFound('That account could not be found');
    return account;
  },

  /**
   * Create an account directly, with no lead behind it.
   *
   * Matt, 6:10: *"we need the ability to create customer accounts manually
   * without going through the lead and invite process. For the larger builders
   * like Clarendon Homes… we'll just create the account for them."*
   */
  async create(draft: AccountDraft): Promise<AccountListItem> {
    const code = draft.customerCode.trim().toUpperCase();

    /*
     * Checked before the insert so the message names the field.
     *
     * The unique index is still the real guard — two simultaneous creates would
     * both pass this check — but a raw duplicate-key error reaches the office as
     * "E11000 duplicate key", which tells them nothing about what to change.
     */
    if (await accountRepository.codeExists(code)) {
      // Constructed directly rather than via `AppError.conflict`, which takes no
      // issues — the field path is what lets the form highlight the right input.
      throw new AppError(409, 'CONFLICT', `${code} is already in use by another account`, {
        issues: [
          {
            path: 'customerCode',
            message: 'That customer code already belongs to another account',
          },
        ],
      });
    }

    const contactName = draft.accountsContactName.trim();
    const contactEmail = draft.accountsContactEmail.trim();

    /*
     * An email with nobody attached to it is a support call waiting to happen —
     * the office cannot tell later whose address it was.
     */
    if (contactEmail !== '' && contactName === '') {
      throw AppError.validation('Name the person that email belongs to', [
        { path: 'accountsContactName', message: 'Who handles their invoices?' },
      ]);
    }

    return accountRepository.create({
      code,
      name: draft.legalName.trim(),
      accountType: draft.accountType,
      brandId: draft.brandId,
      rateCardId: draft.rateCardId,
      poPolicy: draft.poPolicy,
      captureMode: draft.captureMode,
      abn: draft.abn.trim(),
      paymentTermsDays: draft.paymentTermsDays,
      primaryZone: draft.primaryZone,
      notes: draft.notes.trim(),
      contact: contactName === '' ? null : { name: contactName, email: contactEmail || null },
      /*
       * Terms are only outstanding if we are actually going to ask for them.
       *
       * Matt's large builders never see the self-serve flow — *"we'll just
       * create the account for them"* (6:36) — and their terms live in a
       * contract signed long before this screen existed. Leaving those accounts
       * flagged "awaiting terms" forever would make the flag meaningless for the
       * accounts where it does matter.
       */
      termsAgreedOffSystem: draft.sendInvitation ? null : { termsVersion: TERMS_VERSION },
    });
  },

  /**
   * M4.8b — turn the risk-assessment requirement on or off for an account.
   *
   * Returns the updated account so the screen renders the server's answer
   * rather than its own optimistic guess. It matters more here than usual: this
   * switch changes what a DRIVER is made to do at a fence, and a UI showing
   * "on" while the record says "off" is a compliance gap wearing a tick.
   */
  async setRiskAssessmentRequired(
    id: string,
    required: boolean,
    caller: Caller,
  ): Promise<Account> {
    // Office decision, not a customer's. Checked before the write, not after.
    if (isCustomer(caller)) {
      throw AppError.forbidden('Only the office can change the risk assessment rule');
    }

    const updated = await accountRepository.setRiskAssessmentRequired(id, required);
    if (!updated) throw AppError.notFound('That account could not be found');

    return this.get(id, caller);
  },

  /** Journey A.4 — what has been signed, if anything. */
  async getTermsAcceptance(id: string, caller: Caller): Promise<TermsAcceptance | null> {
    // Read through `get` so the same scoping and not-found rules apply.
    await this.get(id, caller);
    return accountRepository.findTermsAcceptance(id);
  },
};

function isCustomer(caller: Caller): boolean {
  return caller.roles.some((role) => CUSTOMER_ROLES.has(role));
}

/**
 * Turn a caller into a query constraint.
 *
 * ⚠️ A customer role with no `accountId` is scoped to a value that matches
 * nothing rather than to `null` — `null` means "see everything" to the
 * repository, and a misconfigured user must fail closed.
 */
function scopeFor(caller: Caller): AccountScope {
  if (!isCustomer(caller)) return { accountId: null };
  return { accountId: caller.accountId ?? '000000000000000000000000' };
}
