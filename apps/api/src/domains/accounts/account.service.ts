import type {
  Account,
  AccountDraft,
  AccountListItem,
  AccountType,
  AccountUpdate,
  BrandId,
  CaptureMode,
  InvitationResult,
  PageMeta,
  PoPolicy,
  Role,
  Zone,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { buildWelcomeEmail } from '../../integrations/notice-messages.js';
/*
 * The one send function (M8.1). Imported here rather than reimplemented so a
 * welcome email obeys the same once-only guard, the same contact preferences
 * and the same never-throw rule as every other message the platform sends.
 */
import { outboundService } from '../notifications/outbound.service.js';
/*
 * Supervisors live in the portal domain because that is where the customer
 * manages them. Read from here, not re-queried, so "who can still sign in" has
 * one definition — the same one the portal screen shows.
 */
import { supervisorRepository } from '../portal/supervisor.repository.js';
// Read-only: "does this rate card exist?" is the settings domain's question.
import { settingsRepository } from '../settings/settings.repository.js';
import {
  accountRepository,
  type AccountScope,
  type ListAccountsQuery,
} from './account.repository.js';

/*
 * `TERMS_VERSION` used to live here. The terms feature was removed on the
 * client's instruction — see the note in `packages/shared/src/schemas/party.ts`.
 */

/** The roles whose view is narrowed to their own account. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

/** What the caller is, as the service needs it. */
export interface Caller {
  roles: readonly Role[];
  /** Set for the two customer roles; null for office and admin. */
  accountId: string | null;
}

/**
 * Everything an account needs, whichever door it came through.
 *
 * Deliberately the union of what the two callers hold: the direct-create draft
 * and a lead conversion. A field that belongs on one belongs on both — that is
 * the whole reason this type exists rather than two near-identical call sites.
 */
export interface AccountProvision {
  customerCode: string;
  legalName: string;
  abn: string;
  accountType: AccountType;
  brandId: BrandId;
  rateCardId: string;
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  paymentTermsDays: number;
  primaryZoneId: Zone;
  accountsContactName: string;
  accountsContactEmail: string;
  notes: string;
  /** Whether the caller will follow up with `sendWelcome`. Validated here. */
  sendInvitation: boolean;
  /*
   * `termsAgreedOffSystem` used to be here, and was the ONE field the two doors
   * answered differently — the last thing standing between them. It went with
   * the terms feature, so the two paths are now identical by construction
   * rather than by agreement.
   */
}

/** The create response: the row for the grid, plus what actually reached them. */
export interface CreatedAccount {
  account: AccountListItem;
  /** `null` when no invitation was asked for. */
  welcome: InvitationResult | null;
}

const log = logger.child({ module: 'accounts' });

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
   * Create an account — the shared core both doors run through.
   *
   * ── Why this is one function and not two ──────────────────────────────────
   * There are two ways an account comes into existence: typed in on the
   * Customers tab, or converted from a lead. They were separate implementations
   * that drifted, and the drift was invisible to anybody looking at only one of
   * them — a rate card silently defaulted on one screen and forced on the other,
   * a duplicate code that suggested a free one here and did not there, a contact
   * rule enforced in one place. Two doors into the same room have to leave the
   * room in the same state.
   *
   * ⚠️ It does NOT send the welcome email. `sendWelcome` is separate and the
   * caller runs it LAST, once everything that can still fail has succeeded —
   * conversion has a lead to mark converted in between, and an email sent before
   * that mark would go out for an account the next step might reject.
   */
  async provision(input: AccountProvision): Promise<AccountListItem> {
    const code = input.customerCode.trim().toUpperCase();

    /*
     * Checked before the insert so the message names the field.
     *
     * The unique index is still the real guard — two simultaneous creates would
     * both pass this check — but a raw duplicate-key error reaches the office as
     * "E11000 duplicate key", which tells them nothing about what to change.
     */
    if (await accountRepository.codeExists(code)) {
      /*
       * The suggestion is the point.
       *
       * Both screens propose "first three letters + 001", so every builder whose
       * name starts the same way collides on the same code — and a bare "that
       * code is taken" asks the office to guess against a list only the server
       * can see.
       */
      const suggestion = await accountRepository.nextFreeCode(code);

      // Constructed directly rather than via `AppError.conflict`, which takes no
      // issues — the field path is what lets the form highlight the right input.
      throw new AppError(409, 'CONFLICT', `${code} is already in use by another account`, {
        issues: [
          {
            path: 'customerCode',
            message: suggestion
              ? `${suggestion} is free — use that, or type another code.`
              : 'That customer code already belongs to another account',
          },
        ],
      });
    }

    /*
     * WARNING: the rate card must EXIST.
     *
     * It used to be an enum, so Mongo refused an unknown value and the check
     * was implicit. Cards are runtime data now — an administrator adds them —
     * so an id that names nothing would be accepted and the account would fail
     * to price its first booking, on a booking form, in front of a customer.
     * Failing here names the field instead.
     */
    await assertRateCardExists(input.rateCardId);

    /*
     * WARNING: the zone must EXIST — the same story as the rate card above, and
     * it became true on the same day.
     *
     * `enum: ZONES` on the model was the only thing rejecting an unknown zone.
     * Zones are runtime data now, so `primaryZoneId: '68f3…dead'` would save
     * cleanly and the account would carry a zone nothing can name — on the
     * customer detail screen, on the accounts grid, and in the financial report.
     */
    await assertZoneExists(input.primaryZoneId);

    const contactName = input.accountsContactName.trim();
    const contactEmail = input.accountsContactEmail.trim();

    /*
     * An email with nobody attached to it is a support call waiting to happen —
     * the office cannot tell later whose address it was.
     */
    if (contactEmail !== '' && contactName === '') {
      throw AppError.validation('Name the person that email belongs to', [
        { path: 'accountsContactName', message: 'Who handles their invoices?' },
      ]);
    }

    /*
     * ⚠️ Refused BEFORE the account exists, not reported as a failed send after.
     *
     * "Email them the onboarding link" with no address to email is a promise the
     * screen cannot keep: the account opens, the toast says an invitation is on
     * its way, and nothing was ever queued. Whoever ticked the box has no reason
     * to look again. Asking for the address now is the only moment this is still
     * cheap to fix.
     */
    if (input.sendInvitation && contactEmail === '') {
      throw AppError.validation('There is no address to send the invitation to', [
        {
          path: 'accountsContactEmail',
          message: 'Add an email address, or untick the invitation',
        },
      ]);
    }

    return accountRepository.create({
      code,
      name: input.legalName.trim(),
      accountType: input.accountType,
      brandId: input.brandId,
      rateCardId: input.rateCardId,
      poPolicy: input.poPolicy,
      captureMode: input.captureMode,
      abn: input.abn.trim(),
      paymentTermsDays: input.paymentTermsDays,
      primaryZoneId: input.primaryZoneId,
      notes: input.notes.trim(),
      contact: contactName === '' ? null : { name: contactName, email: contactEmail || null },
    });
  },

  /**
   * "Your account is open" — the last step, and the only one allowed to fail.
   *
   * ⚠️ Never throws, and must be called LAST. This is the worst possible place
   * to lose an account that already exists: the code is taken and, on a
   * conversion, the lead is marked converted — and neither can be undone by a
   * mail server being down. So the outcome is RETURNED rather than thrown, and
   * the screen tells the office which of the two happened while they can still
   * act on it.
   */
  async sendWelcome(
    account: AccountListItem,
    recipient: { contactName: string; email: string },
  ): Promise<InvitationResult> {
    const welcome = await outboundService.send({
      event: 'account-welcome',
      subjectKey: `account-welcome:${account.id}`,
      recipient: { email: recipient.email.trim() || null, mobile: null },
      email: (to) =>
        buildWelcomeEmail(to, {
          contactName: recipient.contactName,
          legalName: account.name,
          customerCode: account.code,
        }),
      accountId: account.id,
    });

    log.info({ accountId: account.id, outcome: welcome.outcome }, 'welcome email attempted');

    return welcome;
  },

  /**
   * Create an account directly, with no lead behind it.
   *
   * Matt, 6:10: *"we need the ability to create customer accounts manually
   * without going through the lead and invite process. For the larger builders
   * like Clarendon Homes… we'll just create the account for them."*
   */
  async create(draft: AccountDraft): Promise<CreatedAccount> {
    const account = await this.provision({
      customerCode: draft.customerCode,
      legalName: draft.legalName,
      abn: draft.abn,
      accountType: draft.accountType,
      brandId: draft.brandId,
      rateCardId: draft.rateCardId,
      poPolicy: draft.poPolicy,
      captureMode: draft.captureMode,
      paymentTermsDays: draft.paymentTermsDays,
      primaryZoneId: draft.primaryZoneId,
      accountsContactName: draft.accountsContactName,
      accountsContactEmail: draft.accountsContactEmail,
      notes: draft.notes,
      sendInvitation: draft.sendInvitation,
    });

    // Last, and unable to throw — see `sendWelcome`.
    const welcome = draft.sendInvitation
      ? await this.sendWelcome(account, {
          contactName: draft.accountsContactName.trim(),
          email: draft.accountsContactEmail.trim(),
        })
      : null;

    return { account, welcome };
  },

  /**
   * Correct an existing account's details.
   *
   * ── Why this endpoint exists ──────────────────────────────────────────────
   * Because an account could be created and then never edited. The only two
   * things the API would change afterwards were the risk-assessment switch and
   * builder ↔ contractor — so a misspelt company name, a wrong ABN, a moved
   * registered address or a mistyped accounts email were permanent, and the
   * only workaround was a second account with the same ABN, which splits a
   * customer's invoices and their history.
   *
   * Worse, four of these fields could only ever be written by the CUSTOMER, on
   * a portal form, and were returned by no endpoint at all — so the people who
   * raise the invoices could neither see nor fix the details the invoice is
   * printed from.
   *
   * ⚠️ Not a customer's endpoint. A customer administrator changes their own
   * details through the portal, where the form is theirs and the wording says
   * so. Refused here independently of the route's role gate, because only the
   * service's refusal is a boundary.
   *
   * ⚠️ Nothing here re-prices anything. The rate card, the payment terms, the
   * PO policy and the capture mode are absent from `AccountUpdate` entirely.
   */
  async update(id: string, input: AccountUpdate, caller: Caller): Promise<Account> {
    if (isCustomer(caller)) {
      throw AppError.forbidden('Only the office can edit an account’s details');
    }

    const contactName = input.accountsContactName.trim();
    const contactEmail = input.accountsContactEmail.trim();

    /*
     * The same rule the create path applies. An email with nobody attached to
     * it is a support call waiting to happen — the office cannot tell later
     * whose address it was.
     */
    if (contactEmail !== '' && contactName === '') {
      throw AppError.validation('Name the person that email belongs to', [
        { path: 'accountsContactName', message: 'Who handles their invoices?' },
      ]);
    }

    const updated = await accountRepository.update(id, {
      name: input.legalName.trim(),
      tradingName: input.tradingName.trim() || null,
      abn: input.abn.trim(),
      addressLine: input.addressLine.trim() || null,
      suburb: input.suburb.trim() || null,
      postcode: input.postcode.trim() || null,
      certificateEmail: input.certificateEmail.trim().toLowerCase() || null,
      notes: input.notes.trim(),
      /*
       * A blank name leaves the existing contact ALONE rather than deleting it.
       *
       * Clearing both fields reads as "I did not want to change the contact",
       * not "remove the only address their invoices go to" — and an account
       * with nowhere to send an invoice is not a state a typo should be able to
       * reach. Removing a contact is the contacts screen's job.
       */
      contact: contactName === '' ? null : { name: contactName, email: contactEmail || null },
    });

    if (!updated) throw AppError.notFound('That account could not be found');

    log.info({ accountId: id, by: caller.roles.join(',') }, 'account details corrected');

    // The server's answer, not the caller's optimistic guess — the detail page
    // renders what was actually stored, including the fields it normalised.
    return this.get(id, caller);
  },

  /**
   * M4.8b — turn the risk-assessment requirement on or off for an account.
   *
   * Returns the updated account so the screen renders the server's answer
   * rather than its own optimistic guess. It matters more here than usual: this
   * switch changes what a DRIVER is made to do at a fence, and a UI showing
   * "on" while the record says "off" is a compliance gap wearing a tick.
   */
  /**
   * M7.5 — choose the invoice template this account is billed on.
   *
   * ── Why the template is checked, and not defaulted on a miss ──────────────
   * ⚠️ Same reasoning as the rate card above. An account pointed at a template
   * that no longer exists falls back to its brand SILENTLY at render time, so
   * the invoice goes out on the wrong letterhead and looks entirely healthy
   * doing it. Refusing here is the only point at which anybody finds out.
   *
   * Null is not a miss — it is the explicit "follow the brand", and it is what
   * almost every account should carry.
   */
  async setInvoiceTemplate(
    id: string,
    invoiceTemplateId: string | null,
    caller: Caller,
  ): Promise<Account> {
    // Commercial, so the office decides it. Checked before the write.
    if (isCustomer(caller)) {
      throw AppError.forbidden('Only the office can change an account’s invoice template');
    }

    if (invoiceTemplateId !== null) {
      if (!(await settingsRepository.findInvoiceTemplate(invoiceTemplateId))) {
        throw AppError.validation('That invoice template does not exist', [
          {
            path: 'invoiceTemplateId',
            message: 'Pick one from the list — it may have been renamed or deleted',
          },
        ]);
      }
    }

    const updated = await accountRepository.setInvoiceTemplate(id, invoiceTemplateId);
    if (!updated) throw AppError.notFound('That account could not be found');

    return this.get(id, caller);
  },

  async setRiskAssessmentRequired(id: string, required: boolean, caller: Caller): Promise<Account> {
    // Office decision, not a customer's. Checked before the write, not after.
    if (isCustomer(caller)) {
      throw AppError.forbidden('Only the office can change the risk assessment rule');
    }

    const updated = await accountRepository.setRiskAssessmentRequired(id, required);
    if (!updated) throw AppError.notFound('That account could not be found');

    return this.get(id, caller);
  },

  /**
   * Move an account between the two journeys — builder or contractor.
   *
   * ── Why this endpoint exists ──────────────────────────────────────────────
   * The type decides whether the customer gets site supervisors and whether
   * their booking form asks for the area and bag count (Matt, 21:55). It was
   * settable only at creation, so a wrong choice — or a customer whose business
   * changed — was permanent, and the workaround was a second account with the
   * same ABN, which splits their invoices and their history.
   *
   * ⚠️ Builder → contractor is refused while supervisors can still sign in.
   * The contractor journey has no supervisor screen, so their logins would keep
   * working with nobody able to see, suspend or replace them — an account whose
   * own administrator cannot answer "who can book on my account". Suspending
   * them first is a deliberate act by the customer's administrator, which is
   * whose decision it is.
   */
  async setAccountType(id: string, accountType: AccountType, caller: Caller): Promise<Account> {
    // Office decision, not a customer's. Checked before the write, not after.
    if (isCustomer(caller)) {
      throw AppError.forbidden('Only the office can change a customer’s type');
    }

    // Read through `get` so the same scoping and not-found rules apply, and so
    // the current type is the stored one rather than something the caller sent.
    const account = await this.get(id, caller);

    // Idempotent: a retried request must not fail on the supervisor check for a
    // change it is not making.
    if (account.accountType === accountType) return account;

    if (accountType === 'contractor') {
      const supervisors = await supervisorRepository.countLive(id);

      if (supervisors > 0) {
        throw AppError.conflict(
          `${account.name} has ${String(supervisors)} site ${
            supervisors === 1 ? 'supervisor' : 'supervisors'
          } who can still sign in. A contractor account has no supervisor screen, so suspend them in the portal first.`,
        );
      }
    }

    const updated = await accountRepository.setAccountType(id, accountType);
    if (!updated) throw AppError.notFound('That account could not be found');

    return this.get(id, caller);
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

/**
 * Refuse a rate card that does not exist.
 *
 * ── Why this lives here rather than in the schema ─────────────────────────
 * `RateCardIdSchema` validates the SHAPE of an id, which is all a schema can
 * do: whether `metricon-homes` names a real card is a question about stored
 * data, and the set of cards changes while the process is running.
 *
 * ⚠️ Not defaulted to `default` on a miss, tempting as that is. An account
 * quietly repointed at the fallback card would invoice at the wrong rates and
 * look entirely healthy doing it — a pricing incident nobody notices until the
 * customer does (M6.1).
 */
/**
 * The zone exists, and is still offered.
 *
 * ⚠️ One of the guards that REPLACED `enum: ZONES` on the account model. Mongo
 * used to refuse an unknown zone; nothing does now except this.
 *
 * Archived is refused too: a retired zone is one the office has stopped
 * servicing, and putting a new customer's primary zone there would seed a
 * relationship into a market that is being wound down.
 */
async function assertZoneExists(zoneId: string): Promise<void> {
  const zone = await settingsRepository.findZone(zoneId);

  if (!zone) {
    throw AppError.validation('That is not a zone', [
      { path: 'primaryZoneId', message: 'Choose one of the zones from the list' },
    ]);
  }

  if (zone.archived) {
    throw AppError.validation('That zone has been retired', [
      {
        path: 'primaryZoneId',
        message: `${zone.label} is no longer serviced — choose another zone`,
      },
    ]);
  }
}

async function assertRateCardExists(rateCardId: string): Promise<void> {
  if (await settingsRepository.findRateCard(rateCardId)) return;

  throw AppError.validation('That rate card does not exist', [
    {
      path: 'rateCardId',
      message: 'Pick a card from the list — it may have been renamed or retired',
    },
  ]);
}
