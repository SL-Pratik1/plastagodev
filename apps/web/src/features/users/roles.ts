import { ROLES, type Role } from '@plastago/shared';

/**
 * Which roles a seat may hand out, and how the users screen narrows itself.
 *
 * ── Why this is one module and not a check per screen ──────────────────────
 * "Operations invites customer users only" has to hold in four places at once:
 * the role dropdown in the invite dialog, the Role filter on the grid, the rows
 * the grid asks for, and the row-level actions. Written inline, those four
 * drift — the dropdown gets fixed and the grid keeps offering "Edit user" on an
 * office worker, which is a worse state than not having the screen at all.
 *
 * ⚠️ Presentation only. The server owns the real rule; this decides what is
 * offered, never what is permitted.
 */
export const CUSTOMER_ROLES = ['customer-administrator', 'customer-site-supervisor'] as const;

export function isCustomerRole(role: Role): boolean {
  return role.startsWith('customer-');
}

/**
 * The roles a seat can assign.
 *
 * `canManageAll` is `can('users:manage')` — the administrator's full grant.
 * Everyone else on this screen holds `users:manage-customers` and sees two.
 */
export function assignableRoles(canManageAll: boolean): readonly Role[] {
  return canManageAll ? ROLES : CUSTOMER_ROLES;
}
