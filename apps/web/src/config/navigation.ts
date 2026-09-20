import {
  CalendarSyncIcon,
  BellIcon,
  BriefcaseIcon,
  CalendarClockIcon,
  CalendarXIcon,
  Building2Icon,
  ClipboardCheckIcon,
  FileScanIcon,
  FileSearchIcon,
  LandmarkIcon,
  FileTextIcon,
  IdCardIcon,
  LayoutDashboardIcon,
  ReceiptIcon,
  SettingsIcon,
  SproutIcon,
  TriangleAlertIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Capability } from '@/features/auth/permissions';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Hidden unless the signed-in role holds this. */
  capability: Capability;
  /** `true` for a route that would otherwise match its children. */
  end?: boolean;
  /** Tooltip on the collapsed rail, and the scope reference for developers. */
  scope?: string;
  /**
   * Kept out of the menu without being deleted. The route, its guard and its
   * capability mapping all stay live, so a typed URL or a saved link still
   * reaches the screen — this only stops the link being offered.
   */
  hidden?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: readonly NavItem[];
}

/**
 * The console's navigation, and the only place it is defined.
 *
 * ── Why grouped, and in this order ─────────────────────────────────────────
 * Presented as a flat list of twelve links they would read as equally important
 * and equally frequent, which they are not: the dashboard and the job list are
 * opened hourly, integrations twice a year. The grouping encodes that — the
 * daily loop first (their own six favourite screens live in Operations and
 * Commercial), the register of people and assets next, configuration below that,
 * and system records last.
 *
 * Every item carries its capability, so `permissions.ts` is the single source of
 * truth for both the menu and the route guard. A link a role cannot use is never
 * rendered, and the guard behind it is not decoration — it is what stops a typed
 * URL.
 *
 * Every destination here is now a built screen. When one is added ahead of its
 * implementation, give it a scaffold page that says so rather than a dead link —
 * a complete-looking console reads as a nearly-complete system.
 */
export const ADMIN_NAV: readonly NavGroup[] = [
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        to: '/admin',
        label: 'Dashboard',
        icon: LayoutDashboardIcon,
        capability: 'ops:dashboard',
        end: true,
        scope: 'M9.4 · F15 — outstanding work, breaches, queues, sync health',
      },
      {
        to: '/admin/jobs',
        label: 'Jobs',
        icon: BriefcaseIcon,
        capability: 'jobs:read',
        scope: 'M2.1–M2.5 · F4, F5, F6, F7, F30 — create, find and work a job',
      },
      {
        to: '/admin/dispatch',
        label: 'Dispatch',
        icon: TruckIcon,
        capability: 'dispatch:manage',
        scope: 'M3 · F33 — allocation board, run sheets, map',
      },
    ],
  },
  /**
   * The exception queues, second only to the daily operations loop.
   *
   * Grouped rather than scattered because they are one activity — clearing what
   * the system could not decide by itself — and because two of them (M2.6, M2.7)
   * are already among the office's five most-used screens today. Putting them
   * behind Jobs, or inside Invoices, is how the year-old unactioned futile
   * pickup happened: nothing was ever wrong on the screen anyone was looking at.
   */
  {
    id: 'queues',
    label: 'Queues',
    items: [
      {
        to: '/admin/queues/futile',
        label: 'Futile review',
        icon: TriangleAlertIcon,
        capability: 'queues:action',
        scope: 'M2.6 — driver-marked futile pickups; reschedule or cancel, fee applies either way',
      },
      {
        to: '/admin/queues/approvals',
        label: 'Approvals',
        icon: ClipboardCheckIcon,
        capability: 'queues:action',
        scope: 'M2.7 — driver-raised charges with photo evidence, approved before invoicing',
      },
      {
        to: '/admin/queues/awaiting-po',
        label: 'Awaiting PO',
        icon: WalletIcon,
        capability: 'queues:action',
        scope: 'M7.3 — approved charges that cannot be invoiced until a PO arrives',
      },
      {
        to: '/admin/queues/po-review',
        label: 'PO review',
        icon: FileScanIcon,
        capability: 'queues:action',
        scope: 'M2.12 · I6 + I8 — emailed POs the AI could not match with confidence',
      },
      {
        to: '/admin/queues/call-ups',
        label: 'Waiting for a date',
        icon: CalendarClockIcon,
        capability: 'queues:action',
        scope: 'M2.12b — confirmed orders whose call-up has not arrived, bookable by hand',
      },
      {
        /*
         * M5.4 — a customer cannot edit a pickup once it is on a run sheet;
         * the portal sends them here instead and tells them the office has
         * it. Nothing read these rows until this screen existed, so the
         * promise was empty. Listed beside the other worklists because it
         * is the same activity: answering something the system cannot.
         */
        to: '/admin/queues/change-requests',
        label: 'Change requests',
        icon: CalendarSyncIcon,
        capability: 'queues:action',
        scope: 'M5.4 — reschedules and cancellations asked for from the portal',
        hidden: true,
      },
      {
        to: '/admin/queues/call-up-review',
        label: 'Call-ups to check',
        icon: CalendarXIcon,
        capability: 'queues:action',
        /*
         * Listed after "Waiting for a date" but the more urgent of the two: a
         * waiting order is normal until it is not, whereas a row here means a
         * builder has already given us a date nobody has acted on.
         */
        scope: 'M2.12b — call-up messages the system could not apply on its own',
      },
      {
        to: '/admin/queues/leads',
        label: 'Leads',
        icon: SproutIcon,
        capability: 'leads:manage',
        scope: 'M5 · Journey A — enquiries, onboarding, and convert to account',
      },
      /*
       * The notification centre lives with the queues, not under Configuration.
       * M8.7 is the *digest of these four queues* — "the fix for the year-old
       * unactioned futile pickup" — so it belongs beside the work it chases, not
       * beside the settings screens. Configuring notification channels (M8.4 ·
       * W5) is a different thing and is a tab inside Settings.
       */
      {
        to: '/admin/notifications',
        label: 'Alerts',
        icon: BellIcon,
        capability: 'notifications:read',
        scope: 'M8.7 — what needs action, and how long it has waited',
      },
    ],
  },
  {
    id: 'commercial',
    label: 'Commercial',
    items: [
      {
        to: '/admin/customers',
        label: 'Customers',
        icon: Building2Icon,
        capability: 'accounts:manage',
        scope: 'M2.8 · W8 · F29 — accounts, sites, contacts, preferences',
      },
      {
        to: '/admin/invoices',
        label: 'Invoices',
        icon: ReceiptIcon,
        capability: 'invoices:read',
        scope: 'M7 · F8, F39, F49 — two-invoice workflow, awaiting-PO queue, Xero',
      },
      {
        to: '/admin/reports',
        label: 'Reports',
        icon: FileTextIcon,
        capability: 'reports:read',
        scope: 'M9.1–M9.3, M9.6 · W4 — volumes, zones, financial summary',
      },
    ],
  },
  {
    id: 'people',
    label: 'People & fleet',
    items: [
      {
        to: '/admin/users',
        label: 'Users',
        icon: UsersIcon,
        /*
         * The NARROWER of the two user capabilities, on purpose. Both the
         * administrator (`users:manage`) and operations
         * (`users:manage-customers`) open this screen; what differs is the
         * scope inside it, which the page itself decides. Gating the link on
         * the wider one would hide the screen from the seat that holds only
         * the narrow grant.
         */
        capability: 'users:manage-customers',
        scope: 'M1.5 · W1, W2, W16 — roles, sessions, devices, login audit',
      },
      {
        to: '/admin/drivers',
        label: 'Drivers',
        icon: IdCardIcon,
        capability: 'drivers:manage',
        scope: 'M9.8, M9.9 · F53, F22 — licences, tickets, expiry reminders, performance',
      },
      {
        to: '/admin/vehicles',
        label: 'Vehicles',
        icon: WrenchIcon,
        capability: 'vehicles:manage',
        scope: 'M9.7 · F43 — odometer, expenses, cost per km, rego reminders',
      },
    ],
  },
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      {
        to: '/admin/extractor',
        label: 'Extractor',
        icon: FileSearchIcon,
        capability: 'extractor:use',
        scope: 'I6 · M2.12 — the embedded 3PM Extractor: upload, templates, mailbox activity',
      },
      {
        to: '/admin/xero',
        label: 'Xero',
        icon: LandmarkIcon,
        capability: 'integrations:manage',
        scope:
          'I1 · M7.8 — connect the accounting books, then invoices and payment status sync on their own',
      },
      /*
       * ⚠️ Suburbs is deliberately NOT a link here any more.
       *
       * It is M6.3 — the suburbs the picker offers and the zone each one prices
       * in — and it now lives as a tab under Settings → Pricing, beside the zone
       * register and the rate cards it feeds. Splitting it out put one third of a
       * single decision ("what does a job here cost?") in a different navigation
       * group. `/admin/suburbs` still resolves; it redirects to that tab.
       */
      {
        to: '/admin/settings',
        label: 'Settings',
        icon: SettingsIcon,
        capability: 'settings:manage',
        scope: 'W3 · M1.1 · W7 — zones, suburbs, rate cards, brands, invoicing',
      },
    ],
  },
];

/**
 * Filters the tree for a role, dropping groups that end up empty.
 *
 * An empty group heading is worse than no heading: it tells the user something
 * exists that they cannot see.
 */
export function visibleNav(
  can: (capability: Capability) => boolean,
  groups: readonly NavGroup[] = ADMIN_NAV,
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.hidden && can(item.capability)),
    }))
    .filter((group) => group.items.length > 0);
}
