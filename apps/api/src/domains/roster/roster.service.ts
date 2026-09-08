import type { DriverListItem, DriverProfile, PageMeta, Role } from '@plastago/shared';
import { AppError } from '../../lib/app-error.js';
import { rosterRepository, type ListDriversQuery } from './roster.repository.js';

/**
 * The driver roster (M9.8 · F53, M9.9 · F22) — business rules only.
 *
 * ── Who may see it ────────────────────────────────────────────────────────
 * Office roles. A driver does not read the roster: their own licence expiry
 * belongs on their own app (M4), and a screen listing every driver's compliance
 * state and job rate is not something to hand one subcontractor about another.
 *
 * ⚠️ F22 is framed as OPERATIONAL INSIGHT, not performance management, and the
 * framing is load-bearing rather than decorative. There are two drivers; a
 * ranked score for one of two people is a conversation nobody asked for, and the
 * numbers exist to feed the cost-per-km and job-duration models.
 */

export interface Caller {
  userId: string;
  name: string;
  roles: readonly Role[];
}

const OFFICE_ROLES = new Set<Role>(['super-admin', 'operations', 'office-staff', 'allocator']);

export const rosterService = {
  async list(
    query: ListDriversQuery,
    caller: Caller,
  ): Promise<{ data: DriverListItem[]; meta: PageMeta }> {
    assertOffice(caller);

    return rosterRepository.list(query);
  },

  async get(id: string, caller: Caller): Promise<DriverProfile> {
    assertOffice(caller);

    const driver = await rosterRepository.findById(id);
    if (!driver) throw AppError.notFound('No such driver');

    return driver;
  },
};

function assertOffice(caller: Caller): void {
  if (!caller.roles.some((role) => OFFICE_ROLES.has(role))) {
    throw AppError.forbidden('The driver roster is for office staff');
  }
}
