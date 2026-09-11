import { DEFAULT_RATE_CARD_ID, PROTECTED_SERVICE_CODES } from '@plastago/shared';
import type {
  AdditionalServiceCreate,
  AdditionalServiceSetting,
  AdditionalServiceUpdate,
  RateCardCreate,
  RateCardSummary,
  RateCardUpdate,
  RateScheduleCreate,
  Role,
  Settings,
  InvoiceTemplate,
  InvoiceTemplateWrite,
} from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { settingsRepository } from './settings.repository.js';

const log = logger.child({ module: 'settings' });

/**
 * Settings (M2.4, M6).
 *
 * ── Why the rules live here and not in the form ───────────────────────────
 * The settings screen is the one place where a single wrong field changes how
 * every job afterwards behaves — a bank BSB with no account number prints an
 * invoice that gets paid into nothing, and a back-dated rate schedule reprices
 * work that has already been billed. The form validates for the person typing;
 * this validates for everyone downstream, and it is the only one of the two
 * that a script or a stale tab cannot skip.
 */

export interface Caller {
  roles: readonly Role[];
  accountId: string | null;
}

/**
 * Only two roles may write settings.
 *
 * Office staff read them constantly — the SLA and the rate card are on screen
 * while they book — so reading is open to signed-in staff. Writing is not:
 * these are platform-wide, and the blast radius of a mistake is every job.
 *
 * ⚠️ Invoicing is the only writable section left. Notification rules,
 * integration checks and the credential-type register were all removed: each
 * was a write nothing downstream ever read. See the note in `@plastago/shared`'s
 * settings schema for what replaced them, and what deliberately did not.
 */
const WRITERS = new Set<Role>(['super-admin', 'operations']);

/** Customers never see platform settings at all — their rates reach them via a quote. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

export const settingsService = {
  async get(caller: Caller): Promise<Settings> {
    assertStaff(caller);
    return settingsRepository.get();
  },

  /**
   * M7 — invoicing.
   *
   * The bank fields are validated as a pair: an invoice that prints a BSB with
   * no account number gets paid into nothing, and the customer finds out weeks
   * later.
   */
  async saveInvoicing(input: Settings['invoicing'], caller: Caller): Promise<Settings['invoicing']> {
    assertWriter(caller);

    const bsb = input.bankBsb.trim();
    const account = input.bankAccount.trim();

    if ((bsb === '') !== (account === '')) {
      throw AppError.validation('Bank details must be given together, or left blank together', [
        {
          path: bsb === '' ? 'bankBsb' : 'bankAccount',
          message: 'Both a BSB and an account number are needed to print payment details',
        },
      ]);
    }

    if (bsb !== '' && !/^\d{3}-?\d{3}$/.test(bsb)) {
      throw AppError.validation('That BSB does not look right', [
        { path: 'bankBsb', message: 'A BSB is six digits, e.g. 062-000' },
      ]);
    }

    /*
     * Bank details without an account NAME.
     *
     * Allowed but refused-by-default would be the wrong trade either way, so
     * this is a hard refusal: the payer's own banking software asks for the
     * account name, and an invoice that omits it generates a phone call on
     * every first payment from every new customer.
     */
    if (bsb !== '' && input.bankAccountName.trim() === '') {
      throw AppError.validation('Payment details need the account name too', [
        {
          path: 'bankAccountName',
          message: 'The name the account is held in — their bank will ask for it',
        },
      ]);
    }

    /*
     * ⚠️ An ABN is what makes this a TAX invoice.
     *
     * Under GST law a tax invoice over $82.50 must carry the supplier's ABN,
     * and a customer is entitled to withhold payment without one. Refused as
     * a pair with the company name for the same reason the bank fields are:
     * half a letterhead is worse than none, because it looks finished.
     */
    const abn = input.companyAbn.replace(/\s/g, '');
    if (abn !== '' && !/^\d{11}$/.test(abn)) {
      throw AppError.validation('That ABN does not look right', [
        { path: 'companyAbn', message: 'An ABN is eleven digits, e.g. 51 824 753 556' },
      ]);
    }

    if (input.companyName.trim() === '' && abn !== '') {
      throw AppError.validation('An ABN needs the name it belongs to', [
        { path: 'companyName', message: 'Which entity issues these invoices?' },
      ]);
    }

    await settingsRepository.saveInvoicing(input);
    const saved = await settingsRepository.get();
    return saved.invoicing;
  },

  /* ── Invoice templates (M7.5) ──────────────────────────────────────────── */

  async createInvoiceTemplate(
    input: InvoiceTemplateWrite,
    caller: Caller,
  ): Promise<InvoiceTemplate> {
    assertWriter(caller);

    const id = slugify(input.name);
    if (id === '') {
      throw AppError.validation('That name cannot be turned into an id', [
        { path: 'name', message: 'Use at least one letter or digit' },
      ]);
    }

    if (await settingsRepository.findInvoiceTemplate(id)) {
      throw AppError.conflict(`A template with the id "${id}" already exists`);
    }

    await settingsRepository.createInvoiceTemplate(id, input);
    log.info({ templateId: id, layout: input.layout }, 'invoice template created');

    return findTemplateOrThrow(id);
  },

  async updateInvoiceTemplate(
    id: string,
    input: InvoiceTemplateWrite,
    caller: Caller,
  ): Promise<InvoiceTemplate> {
    assertWriter(caller);

    if (!(await settingsRepository.findInvoiceTemplate(id))) {
      throw AppError.notFound(`No invoice template is configured for "${id}"`);
    }

    /*
     * ⚠️ Editing a template does NOT change any invoice already sent.
     *
     * `invoices.templateName` is frozen at render time, and the PDF itself is
     * stored. So renaming or recolouring here affects the NEXT invoice only —
     * which is what makes this safe to expose at all.
     */
    await settingsRepository.updateInvoiceTemplate(id, input);
    log.info({ templateId: id }, 'invoice template updated');

    return findTemplateOrThrow(id);
  },

  /**
   * Retire a template.
   *
   * Refused while any account names it: the account would fall back to its
   * brand default silently, and "why does this builder's invoice suddenly
   * look different?" is a question nobody would connect to a settings change
   * made weeks earlier.
   */
  async deleteInvoiceTemplate(id: string, caller: Caller): Promise<void> {
    assertWriter(caller);

    const existing = await settingsRepository.findInvoiceTemplate(id);
    if (!existing) throw AppError.notFound(`No invoice template is configured for "${id}"`);

    const assigned = await settingsRepository.countAccountsOnTemplate(id);
    if (assigned > 0) {
      throw AppError.conflict(
        `${String(assigned)} account${assigned === 1 ? '' : 's'} still invoice on this template. Move them to another one first.`,
      );
    }

    await settingsRepository.deleteInvoiceTemplate(id);
    log.info({ templateId: id }, 'invoice template deleted');
  },

  /* ── Rate cards (M6.1) ─────────────────────────────────────────────────── */

  /**
   * A new rate card, with its opening schedule.
   *
   * The id is derived from the label when the caller does not supply one, which
   * is what the form does — an administrator naming "Metricon Homes" should not
   * also have to invent `metricon-homes`.
   */
  async createRateCard(input: RateCardCreate, caller: Caller): Promise<RateCardSummary> {
    assertWriter(caller);

    const id = input.id ?? slugify(input.label);
    if (id === '') {
      throw AppError.validation('That name cannot be turned into an id', [
        { path: 'label', message: 'Use at least one letter or digit' },
      ]);
    }

    if (await settingsRepository.findRateCard(id)) {
      // 409 rather than 422: the request is well-formed, it just lost a race
      // with a card that already exists.
      throw AppError.conflict(`A rate card with the id "${id}" already exists`);
    }

    await settingsRepository.createRateCard({
      id,
      label: input.label,
      effectiveFrom: input.effectiveFrom,
      zones: input.zones,
    });

    log.info({ rateCardId: id, effectiveFrom: input.effectiveFrom }, 'rate card created');
    return findCardOrThrow(id);
  },

  async renameRateCard(
    id: string,
    input: RateCardUpdate,
    caller: Caller,
  ): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertCardExists(id);

    await settingsRepository.renameRateCard(id, input.label);
    return findCardOrThrow(id);
  },

  /**
   * ⚠️ Issue a new schedule (M6.2) — the only way a rate ever changes.
   *
   * ── The three refusals, and why each one is a refusal ─────────────────────
   * All of them protect the same invariant: a figure on an invoice the customer
   * has seen must never move.
   *
   *  1. **A duplicate start date.** Two schedules opening on the same day is
   *     ambiguous, and `card_zone_from_unique` would reject it with a
   *     duplicate-key error the caller cannot read. Refusing here says which
   *     date is the problem.
   *
   *  2. **Back-dating behind an invoiced job.** This is the important one. A
   *     schedule starting before a job that has already been invoiced means the
   *     rate tables now disagree with a document in a builder's accounts payable
   *     system. The job's own snapshot keeps the INVOICE honest, but the
   *     disagreement itself is a reconciliation nobody can win, so it is
   *     refused outright rather than warned about.
   *
   *  3. **Back-dating at all is allowed otherwise**, because correcting a rate
   *     that was keyed wrong last week — before anything was billed — is a
   *     legitimate and fairly common fix. Forbidding every back-date would push
   *     that correction into a database console.
   */
  async issueSchedule(
    id: string,
    input: RateScheduleCreate,
    caller: Caller,
  ): Promise<RateCardSummary> {
    assertWriter(caller);
    await assertCardExists(id);

    const starts = await settingsRepository.scheduleStarts(id);
    if (starts.includes(input.effectiveFrom)) {
      throw AppError.validation('That card already has a schedule starting on that date', [
        {
          path: 'effectiveFrom',
          message: 'Pick a different start date, or delete the card and start again',
        },
      ]);
    }

    const earliestInvoiced = await settingsRepository.earliestInvoicedDateOnCard(id);
    if (earliestInvoiced !== null && input.effectiveFrom <= earliestInvoiced) {
      throw AppError.conflict(
        `This card has already invoiced work from ${earliestInvoiced}. A schedule starting on or before that date would disagree with an invoice the customer already has — start it after ${earliestInvoiced} instead.`,
      );
    }

    await settingsRepository.issueSchedule(id, input.effectiveFrom, input.zones);

    log.info(
      { rateCardId: id, effectiveFrom: input.effectiveFrom },
      'rate schedule issued — previous schedule closed',
    );
    return findCardOrThrow(id);
  },

  /**
   * Retire a rate card.
   *
   * Refused while any account names it — an account with a dangling card would
   * fail to price its next booking, and the failure would surface on a booking
   * form rather than here. `default` is refused unconditionally because
   * `resolveRate` falls back to it.
   *
   * Jobs already priced on the card are unaffected: each carries its own frozen
   * snapshot, which is what makes retiring a card safe at all.
   */
  async deleteRateCard(id: string, caller: Caller): Promise<void> {
    assertWriter(caller);
    await assertCardExists(id);

    if (id === DEFAULT_RATE_CARD_ID) {
      throw AppError.conflict(
        'The default card cannot be deleted — every other card falls back to it when a zone has no rate',
      );
    }

    const accountCount = await settingsRepository.countAccountsOnRateCard(id);
    if (accountCount > 0) {
      throw AppError.conflict(
        `${String(accountCount)} account${accountCount === 1 ? '' : 's'} still price against this card. Move them to another card first.`,
      );
    }

    await settingsRepository.deleteRateCard(id);
    log.info({ rateCardId: id }, 'rate card deleted');
  },

  /* ── Additional services (M6.5) ────────────────────────────────────────── */

  async createAdditionalService(
    input: AdditionalServiceCreate,
    caller: Caller,
  ): Promise<AdditionalServiceSetting> {
    assertWriter(caller);

    if (await settingsRepository.findAdditionalService(input.code)) {
      throw AppError.conflict(`A charge with the code "${input.code}" already exists`);
    }

    assertPercentageInRange(input.kind, input.value);

    await settingsRepository.createAdditionalService(input);
    log.info({ code: input.code, kind: input.kind }, 'additional service created');

    return findServiceOrThrow(input.code);
  },

  /**
   * Reprice or relabel a charge.
   *
   * ⚠️ Reachable for the protected codes too, and deliberately so: repricing
   * the futile fee from $120 to $135 is the single most likely thing anybody
   * will ever do on this screen. What is refused is DELETING those codes, not
   * editing them.
   *
   * `kind` is not in the payload — see the note on the update schema.
   */
  async updateAdditionalService(
    code: string,
    input: AdditionalServiceUpdate,
    caller: Caller,
  ): Promise<AdditionalServiceSetting> {
    assertWriter(caller);

    const existing = await settingsRepository.findAdditionalService(code);
    if (!existing) throw AppError.notFound(`No charge is configured for "${code}"`);

    assertPercentageInRange(existing.kind, input.value);

    /*
     * A system-generated charge cannot be made driver-raisable. It is derived
     * from data the driver already captured — bag counts, on-site minutes — so
     * offering it as a button on their phone would let the same charge be
     * raised twice for one job, once by hand and once by the derivation.
     */
    if (existing.systemGenerated && input.driverRaisable) {
      throw AppError.validation('This charge is raised by the system, not by a driver', [
        {
          path: 'driverRaisable',
          message: `"${existing.label}" is derived from what the driver captured, so offering it as a button would raise it twice`,
        },
      ]);
    }

    await settingsRepository.updateAdditionalService(code, input);
    log.info({ code, value: input.value }, 'additional service updated');

    return findServiceOrThrow(code);
  },

  /**
   * Remove a charge.
   *
   * The five protected codes are refused: the application looks each one up by
   * literal name, so deleting one turns a driver tapping "Report
   * contamination" into a 500 rather than shortening a list on this screen.
   */
  async deleteAdditionalService(code: string, caller: Caller): Promise<void> {
    assertWriter(caller);

    const existing = await settingsRepository.findAdditionalService(code);
    if (!existing) throw AppError.notFound(`No charge is configured for "${code}"`);

    if ((PROTECTED_SERVICE_CODES as readonly string[]).includes(code)) {
      throw AppError.conflict(
        `"${existing.label}" is raised by the system itself and cannot be removed. Set its amount to $0.00 if you no longer charge for it.`,
      );
    }

    const usedOnJobs = await settingsRepository.countChargesWithCode(code);
    if (usedOnJobs > 0) {
      throw AppError.conflict(
        `"${existing.label}" has been raised on ${String(usedOnJobs)} job${usedOnJobs === 1 ? '' : 's'} and is part of their invoices. Set its amount to $0.00 instead of deleting it.`,
      );
    }

    await settingsRepository.deleteAdditionalService(code);
    log.info({ code }, 'additional service deleted');
  },
};

/* ── Guards ──────────────────────────────────────────────────────────────── */

function assertStaff(caller: Caller): void {
  if (caller.roles.some((role) => CUSTOMER_ROLES.has(role))) {
    // Plain 403 here rather than the 404 the accounts domain uses: settings are
    // not a row whose existence is a secret, and pretending the endpoint is
    // missing would just make a support call harder.
    throw AppError.forbidden('Platform settings are not available on a customer account');
  }
}

function assertWriter(caller: Caller): void {
  assertStaff(caller);
  if (!caller.roles.some((role) => WRITERS.has(role))) {
    throw AppError.forbidden('Only an administrator can change platform settings');
  }
}

async function assertCardExists(id: string): Promise<void> {
  if (!(await settingsRepository.findRateCard(id))) {
    throw AppError.notFound(`No rate card is configured for "${id}"`);
  }
}

/**
 * Re-read the card from the settings tree so the caller gets what was STORED.
 *
 * Not the input echoed back: `accountCount`, `deletable` and the closed window
 * on the previous schedule are all computed by the read, and a response
 * assembled from the request would show a schedule as open that the write had
 * just closed.
 */
async function findCardOrThrow(id: string): Promise<RateCardSummary> {
  const settings = await settingsRepository.get();
  const card = settings.pricing.rateCards.find((candidate) => candidate.id === id);
  if (!card) throw AppError.notFound(`No rate card is configured for "${id}"`);
  return card;
}

async function findServiceOrThrow(code: string): Promise<AdditionalServiceSetting> {
  const service = await settingsRepository.findAdditionalService(code);
  if (!service) throw AppError.notFound(`No charge is configured for "${code}"`);
  return service;
}

/**
 * A percentage over 100 is almost always a typo for a fixed amount.
 *
 * `MoneySchema` already refuses negatives and nonsense, but it cannot know that
 * `10` means ten percent here and `1000` means a fuel levy ten times the job.
 * Zero is allowed: it is how a levy is switched off without deleting it.
 */
function assertPercentageInRange(kind: 'fixed' | 'percentage', value: string): void {
  if (kind !== 'percentage') return;

  if (Number(value) > 100) {
    throw AppError.validation('That percentage is above 100%', [
      {
        path: 'value',
        message: 'Enter the percentage itself — 10 for ten percent, not 1000',
      },
    ]);
  }
}

/**
 * A label into an id — "Metricon Homes" → `metricon-homes`.
 *
 * Returns an empty string when nothing usable survives, which the caller turns
 * into a field error rather than writing a card with a blank id.
 */
function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/*
 * ── Why there is no timezone handling in this file ────────────────────────
 * Every date here is a `YYYY-MM-DD` string, and those compare correctly with
 * `<=` without knowing anything about offsets. A string becomes an instant in
 * exactly one place — `startOfSydneyDay`, in the repository — which is what
 * keeps "effective from 1 October" from starting at 11am on 30 September.
 */

/*
 * There is no sequence guard here any more, because there is no route that
 * could carry a sequence. `nextJobNumber` and `nextInvoiceNumber` are reachable
 * only through `settingsRepository.takeNextNumber()`, which advances them
 * atomically — so the thing the guard existed to refuse is now unrepresentable
 * rather than merely rejected. That is the stronger version of the same rule.
 */

/** Re-read a template from the settings tree, so counts and flags are real. */
async function findTemplateOrThrow(id: string): Promise<InvoiceTemplate> {
  const settings = await settingsRepository.get();
  const template = settings.invoicing.templates.find((candidate) => candidate.id === id);
  if (!template) throw AppError.notFound(`No invoice template is configured for "${id}"`);
  return template;
}
