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
};

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => OFFICE_ROLES.has(role))) {
    throw AppError.forbidden('That reference list is for office staff');
  }
}
