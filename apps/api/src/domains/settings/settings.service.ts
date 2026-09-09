import type { Integration, IntegrationId, Role, Settings } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { logger } from '../../lib/logger.js';
import { settingsRepository } from './settings.repository.js';

const log = logger.child({ module: 'settings' });

/**
 * Settings (M2.4, W7).
 *
 * ── Why the rules live here and not in the form ───────────────────────────
 * The settings screen is the one place where a single wrong field changes how
 * every job afterwards behaves — a bank BSB with no account number prints an
 * invoice that gets paid into nothing. The form validates for the person
 * typing; this validates for everyone downstream, and it is the only one of the
 * two that a script or a stale tab cannot skip.
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
 */
const WRITERS = new Set<Role>(['super-admin', 'operations']);

/** Customers never see platform settings at all — their rates reach them via a quote. */
const CUSTOMER_ROLES = new Set<Role>(['customer-administrator', 'customer-site-supervisor']);

export const settingsService = {
  async get(caller: Caller): Promise<Settings> {
    assertStaff(caller);
    return settingsRepository.get();
  },

  async saveNotifications(
    input: Settings['notifications'],
    caller: Caller,
  ): Promise<Settings['notifications']> {
    assertWriter(caller);

    /*
     * A rule with neither channel on is a notification that will never be sent.
     * That is a legitimate way to switch an event off, so it is allowed — but it
     * is logged, because "the customer never got the reminder" is otherwise a
     * very expensive thing to diagnose.
     */
    const silenced = input.rules.filter((rule) => !rule.sms && !rule.email).map((r) => r.event);
    if (silenced.length > 0) {
      log.warn({ silenced }, 'notification events switched off entirely');
    }

    await settingsRepository.saveNotifications(input);
    const saved = await settingsRepository.get();
    return saved.notifications;
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

    await settingsRepository.saveInvoicing(input);
    const saved = await settingsRepository.get();
    return saved.invoicing;
  },

  /** F53 / M9.8 — driver credential types and how far ahead expiry is warned. */
  async saveCredentialTypes(
    input: Settings['credentialTypes'],
    caller: Caller,
  ): Promise<Settings['credentialTypes']> {
    assertWriter(caller);

    // Duplicate codes would make "which rule applies to an HR licence" ambiguous,
    // and the last one written would silently win.
    const seen = new Set<string>();
    for (const credential of input) {
      if (seen.has(credential.type)) {
        throw AppError.validation('Each credential type may appear once', [
          { path: 'type', message: `"${credential.label}" is listed more than once` },
        ]);
      }
      seen.add(credential.type);
    }

    await settingsRepository.saveCredentialTypes(input);
    const saved = await settingsRepository.get();
    return saved.credentialTypes;
  },

  /**
   * W7 — "test connection".
   *
   * Records the OUTCOME of a check somebody else performed. It deliberately does
   * not reach out to Twilio or Xero itself: a settings screen that can trigger
   * arbitrary outbound calls is a probe, and the check belongs to whichever
   * adapter owns those credentials.
   */
  async recordIntegrationCheck(
    id: IntegrationId,
    outcome: { ok: boolean; detail?: string },
    caller: Caller,
  ): Promise<Integration> {
    assertWriter(caller);

    const existing = await settingsRepository.findIntegration(id);
    if (!existing) throw AppError.notFound(`No integration is configured for "${id}"`);

    await settingsRepository.recordIntegrationCheck(id, {
      state: outcome.ok ? 'connected' : 'error',
      // A failure with no explanation is a red dot nobody can act on, so an
      // absent detail is cleared rather than left showing the last one.
      detail: outcome.detail ?? null,
    });

    log.info({ integration: id, ok: outcome.ok }, 'integration check recorded');

    // Re-read so the caller gets `lastSuccessAt` as the write left it — the
    // stamp is applied by the repository, not by anything the caller sent.
    const updated = await settingsRepository.findIntegration(id);
    if (!updated) throw AppError.notFound(`No integration is configured for "${id}"`);
    return updated;
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

/*
 * There is no sequence guard here any more, because there is no route that
 * could carry a sequence. `nextJobNumber` and `nextInvoiceNumber` are reachable
 * only through `settingsRepository.takeNextNumber()`, which advances them
 * atomically — so the thing the guard existed to refuse is now unrepresentable
 * rather than merely rejected. That is the stronger version of the same rule.
 */
