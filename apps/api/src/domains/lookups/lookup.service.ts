import type { Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { lookupRepository, type LookupRow } from './lookup.repository.js';

/**
 * Reference lists for pickers and filter dropdowns.
 *
 * ── Why these are office-only, unlike the suburb lookup beside them ───────
 * A list of suburbs PlastaGo services is public knowledge. A list of every
 * account, every builder and every driver is the customer register — handing it
 * to a builder's site supervisor would tell them who else PlastaGo works for,
 * which is commercially theirs to know and not ours to give away.
 *
 * The portal has its own scoped screens and needs none of these.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

const OFFICE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

export const lookupService = {
  async accounts(caller: Caller): Promise<LookupRow[]> {
    assertOffice(caller);
    return lookupRepository.accounts();
  },

  async builders(caller: Caller): Promise<LookupRow[]> {
    assertOffice(caller);
    return lookupRepository.builders();
  },

  async drivers(caller: Caller): Promise<LookupRow[]> {
    assertOffice(caller);
    return lookupRepository.drivers();
  },

  /**
   * M6.1 — the rate cards, for the pickers that assign one to an account.
   *
   * ── Why this is a lookup and not read off the settings tree ───────────────
   * It became necessary the moment rate cards stopped being a compile-time
   * enum: four screens — new customer, the customers filter, customer detail
   * and lead conversion — used to render `RATE_CARD_LABELS`, and a card an
   * administrator adds has no entry there.
   *
   * A lookup rather than `GET /settings` because a filter dropdown must not
   * have to load the whole settings tree, schedules and rate history included,
   * to put seven options in a `<select>`.
   */
  async rateCards(caller: Caller): Promise<LookupRow[]> {
    assertOffice(caller);
    return lookupRepository.rateCards();
  },
};

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => OFFICE_ROLES.has(role))) {
    throw AppError.forbidden('That reference list is for office staff');
  }
}
