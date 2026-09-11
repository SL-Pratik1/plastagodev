import {
  AwardIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  ClipboardListIcon,
  HomeIcon,
  PlusCircleIcon,
  ReceiptIcon,
  SettingsIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react';
import type { AccountType } from '@plastago/shared';
import type { Capability } from '@/features/auth/permissions';

export interface PortalNavItem {
  to: string;
  /** Full label, used in the sidebar and the drawer. */
  label: string;
  /** Shorter label for the phone tab bar, where 5 items share 390px. */
  shortLabel: string;
  icon: LucideIcon;
  capability: Capability;
  end?: boolean;
  /** Promoted into the bottom tab bar on phones. */
  primary?: boolean;
  /**
   * Restricts this item to one kind of customer.
   *
   * Only site supervisors need it so far: they are a builder concept, and a
   * contractor *"probably only needs an admin user"* (Matt, 20:09). Hiding the
   * item is the whole feature — a contractor who never sees it never has to work
   * out that it does not apply to them.
   */
  accountTypes?: readonly AccountType[];
  scope?: string;
}

/**
 * The customer portal's navigation (M5 Part 1).
 *
 * ── Why a bottom tab bar on phones and a rail on desktop ──────────────────
 * Because of where this is used. A site supervisor opens it one-handed, standing
 * on a building site, in the rain — the scope document's own image. Thumb reach
 * on a phone is the bottom of the screen, so the four things they actually do
 * live in a fixed bottom bar; a hamburger would put every one of them two taps
 * and a reach away. The Customer Administrator, who is at a desk doing invoices
 * and reports, gets the full list.
 *
 * ── Why `primary` and not just "the first four" ───────────────────────────
 * The tab bar has to hold the *supervisor's* four, and their list is shorter
 * than the administrator's. Marking the primaries explicitly means the bar is
 * correct for both roles instead of accidentally showing an administrator
 * Invoices and a supervisor nothing.
 */
export const PORTAL_NAV: readonly PortalNavItem[] = [
  {
    to: '/portal',
    label: 'Dashboard',
    shortLabel: 'Home',
    icon: HomeIcon,
    capability: 'portal:access',
    end: true,
    primary: true,
    scope: 'M5.7 · F26 — where every pickup is, without phoning the office',
  },
  {
    to: '/portal/book',
    label: 'Book a pickup',
    shortLabel: 'Book',
    icon: PlusCircleIcon,
    capability: 'portal:book',
    primary: true,
    scope: 'M5.1 · F9, F21 — four fields, and readiness certified (M5.2)',
  },
  {
    to: '/portal/jobs',
    label: 'Pickups',
    shortLabel: 'Pickups',
    icon: ClipboardListIcon,
    capability: 'portal:access',
    primary: true,
    scope: 'M5.7, M5.8, M5.9 — live status, history, completion record + photos',
  },
  {
    to: '/portal/purchase-orders',
    label: 'Waiting on a date',
    shortLabel: 'Dates',
    icon: CalendarClockIcon,
    /*
     * `portal:access`, not `portal:book` — a site supervisor has to be able to
     * do this. Matt, 30:40, is describing the supervisor doing it himself when
     * the builder's call-up email fails, and gating it behind the booking
     * capability would lock out the person the screen exists for.
     */
    capability: 'portal:access',
    primary: true,
    scope: 'M2.12b — orders we have, with no date yet; the fallback when the call-up email fails',
  },
  {
    to: '/portal/invoices',
    label: 'Invoices',
    shortLabel: 'Invoices',
    icon: ReceiptIcon,
    capability: 'portal:invoices',
    scope: 'M5.10 · W72, W73 — outstanding and paid, with PO and job reference',
  },
  {
    to: '/portal/reports',
    label: 'Reports',
    shortLabel: 'Reports',
    icon: ChartColumnIcon,
    capability: 'portal:reports',
    scope: 'M5.11 · F1 — the monthly volume report, self-serve',
  },
  {
    to: '/portal/certificates',
    label: 'Certificates',
    shortLabel: 'Certs',
    icon: AwardIcon,
    capability: 'portal:certificates',
    scope: 'M5.12 · F52, W84 — Certificates of Recycling for Green Star',
  },
  {
    to: '/portal/supervisors',
    label: 'Site supervisors',
    shortLabel: 'People',
    icon: UsersIcon,
    capability: 'portal:supervisors',
    // Builders only — see `accountTypes`.
    accountTypes: ['builder'],
    scope: 'M5.14 · W70 — add, remove and scope your own supervisors',
  },
  {
    to: '/portal/account',
    label: 'Account',
    shortLabel: 'Account',
    icon: SettingsIcon,
    capability: 'portal:account',
    scope: 'M5.15 · F29, W71, W81 — contacts and notification preferences',
  },
];

/**
 * The nav for one viewer.
 *
 * `accountType` is optional so a caller that has not resolved the scope yet
 * still gets a sensible menu rather than an empty one — the type-restricted
 * items simply stay hidden until it arrives, which is the safe direction to
 * fail: showing a contractor a supervisors page is worse than showing a builder
 * one screen a moment late.
 */
export function visiblePortalNav(
  can: (capability: Capability) => boolean,
  accountType?: AccountType,
): PortalNavItem[] {
  return PORTAL_NAV.filter((item) => {
    if (!can(item.capability)) return false;
    if (!item.accountTypes) return true;
    return accountType !== undefined && item.accountTypes.includes(accountType);
  });
}
