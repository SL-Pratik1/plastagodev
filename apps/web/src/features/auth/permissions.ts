import { ROLE_SURFACE, type Role } from '@plastago/shared';

/**
 * Capability-based access, checked in one place.
 *
 * ── Why capabilities and not role checks ───────────────────────────────────
 * `role === 'super-admin' || role === 'operations'` scattered across screens is
 * how a permission model rots: the day Operations gains access to integrations,
 * someone has to find every one of those checks. A capability names the
 * *permission*, the matrix below names who holds it, and route guards and nav
 * both read from the matrix — so there is exactly one file to change and one
 * file to audit. That is what §M1.5 needs to stay true over time.
 *
 * ⚠️ SCOPE NOTE. `super-admin` is the row this build implements and the only one
 * that is settled. The other six are a reasoned first cut from the module map in
 * §6 — Operations owns commercial data, the Allocator owns the board and nothing
 * priced, customers see only the portal — and must be confirmed with Matt before
 * their consoles are built. They are here because the guards and navigation need
 * something to read, and because defaulting an unknown role to "sees everything"
 * is the wrong failure mode.
 */
export const CAPABILITIES = [
  // Surface entry
  'admin:access',
  'portal:access',
  /**
   * M4 — the driver surface, `/driver/*`.
   *
   * ── Why the driver holds exactly one capability and no more ────────────
   * The console and the portal are broad surfaces where roles differ from one
   * another *within* them: an allocator sees dispatch but not invoices, a
   * supervisor sees sites but not pricing. That is what capabilities are for.
   *
   * The driver surface has no such variation. There is one driver role, every
   * driver does every part of it, and the thing that varies is not WHICH
   * screens they may open but WHICH RUN they are given — and that is data
   * scoping the server does from the session, not a permission the browser
   * checks. Inventing `driver:photos`, `driver:weights` and the rest would be a
   * matrix with one row and no second opinion: pure ceremony.
   *
   * If a second driver role ever appears — a subcontractor who may not see the
   * tip-off reconciliation, say — this is where it gets split, and the router
   * already wraps the group so the split lands in one place.
   */
  'driver:access',
  /*
   * ── The portal's own capabilities (M5 Part 1) ───────────────────────────
   * Read straight off §12's two customer tables. The Site Supervisor has TEN
   * workflows and every one of them is about a pickup at a site they are on:
   * book it (W88), certify it ready (W86), keep the access notes current (W87,
   * W98), ask for it sooner (W89), set preferred times (W92), see where it is
   * (W95), reschedule it (W97), read the completion record (W99).
   *
   * Not one of them is commercial. So invoices, reports, certificates,
   * supervisor management and account settings are the Customer
   * Administrator's — and `pricing:view` is withheld, which is M1.5's worked
   * example almost word for word.
   */
  'portal:book',
  'portal:invoices',
  'portal:reports',
  'portal:certificates',
  'portal:supervisors',
  'portal:account',
  // Operations
  'ops:dashboard',
  'jobs:read',
  /**
   * W47 — create a job card (M2.1).
   *
   * Separate from `jobs:manage` because the Allocator holds one and not the
   * other: W122 (cancel and reschedule) is in their eleven, W47 is not — it is
   * the Office Worker's. And booking a job means agreeing a price, which is a
   * commercial act the create form shows a live estimate for.
   */
  'jobs:create',
  'jobs:manage',
  'dispatch:manage',
  /**
   * The four exception queues — futile review (M2.6), service approvals (M2.7),
   * awaiting PO (M7.3) and PO review (M2.12).
   *
   * One capability rather than four because they are one job: working the
   * exceptions. Whoever is trusted to approve a $90 contamination charge is the
   * same person trusted to decide a futile pickup, and splitting them would mean
   * four rows to keep in step for no observed difference in who does what.
   */
  'queues:action',
  /**
   * M8.6 · W50, W102 — post to the office ↔ driver comment thread on a job.
   *
   * Separate from `jobs:manage` because it is not a change to the job: the
   * allocator holds it (W102 is theirs) while office staff hold it too (W50),
   * and neither list implies the other. Matt confirmed the office side is
   * *"admin, allocator or office worker"* — which is exactly this set.
   */
  'driver-comms',
  // Commercial
  'accounts:manage',
  'invoices:read',
  'reports:read',
  'certificates:manage',
  /**
   * M5 · Journey A — the leads and onboarding queue.
   *
   * Separate from `queues:action` because converting a lead is a *sales*
   * decision: it sets the rate card, the payment terms and the PO policy. A.4
   * calls it out as human-mediated for exactly that reason, so the office staff
   * who clear futile pickups do not automatically get to price a new customer.
   */
  'leads:manage',
  /**
   * See money: rates, charges, job totals, invoices, margin.
   *
   * ── Why this is a capability and not "has invoices:read" ────────────────
   * Because the Allocator needs the job and *not* the price. M1.5's own worked
   * example is about a site supervisor who "cannot see pricing", and the same
   * separation applies inside the office: allocation is a logistics decision,
   * and W100–W122 — the allocator's whole documented workflow set — contains no
   * commercial workflow at all.
   *
   * Deriving it from `invoices:read` would have been the tempting shortcut and
   * the wrong one: it would silently reveal a job's value on the jobs grid the
   * moment anyone gained invoice access for an unrelated reason.
   *
   * ⚠️ This hides money in the UI. It is NOT a security boundary — the server
   * must scope what it returns. A capability the browser checks is a courtesy
   * to the user, and treating it as protection is how data leaks.
   */
  'pricing:view',
  // Fleet and people
  'users:manage',
  /**
   * M1.5 — invite and manage CUSTOMER users only: the Customer Administrator
   * and the Site Supervisor.
   *
   * ── Why a second capability instead of widening `users:manage` ──────────
   * Because Operations onboards customers and does not administer the office.
   * Matt's seat needs to get a builder's administrator and their supervisors
   * into the portal without waiting on the Administrator — that is the same
   * onboarding job `leads:manage` and `accounts:manage` already sit with. What
   * it must NOT gain is the ability to mint another staff account or change an
   * office worker's role, which is W1/W16 and stays with the Administrator.
   *
   * So the screen is shared and the *scope* differs: this capability opens
   * `/admin/users` narrowed to customer users, `users:manage` opens all seven
   * roles. The narrowing is stated once here and read by the nav, the guard,
   * the grid and the invite form.
   *
   * ⚠️ UI scoping, not a security boundary — the server must apply the same
   * narrowing to the list and reject a staff-role invite from this seat.
   */
  'users:manage-customers',
  'drivers:manage',
  'vehicles:manage',
  /**
   * M8.7 — the notification centre and the bell.
   *
   * ⚠️ NOT the same thing as configuring notifications (M8.4 · W5), which is a
   * tab inside Settings and belongs to the Administrator. The centre holds
   * alerts about the exception queues — "the fix for the year-old unactioned
   * futile pickup" — so whoever works those queues needs to be told about them.
   * Gating the bell on the *config* capability, as an earlier revision did, hid
   * it from Matt and from the office staff who work the queues daily, which is
   * everyone it was built for.
   */
  'notifications:read',
  // Configuration
  'brands:manage',
  'integrations:manage',
  /**
   * I6 — the embedded Extractor tab.
   *
   * Separate from `integrations:manage`, which is the Administrator's alone and
   * covers configuring what the platform talks to. This is USING one: reading a
   * purchase order off a PDF is intake work, and gating it on the config
   * capability would hide it from the office staff who do that work daily.
   */
  'extractor:use',
  'notifications:manage',
  'settings:manage',
  // System
  'audit:read',
  /** The design-system showcase. Development aid, not a business screen. */
  'foundation:view',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The capabilities that belong to somebody ELSE'S session, named once so the
 * admin row can hold them out.
 *
 * ── Why "everything" cannot mean *everything* ─────────────────────────────
 * `portal:*` is not a bigger permission than an admin one; it is a permission on
 * a different surface, and that surface is defined by an account. Every read in
 * the portal narrows to the signed-in user's `accountId` — that narrowing is the
 * whole security model of M1.5, not a filter the UI asked for — so a staff
 * session, which has `accountId: null` by definition, has nothing for those
 * screens to scope to.
 *
 * Granting them to the super admin as part of a blanket `CAPABILITIES` was the
 * bug behind "Your role does not allow that" on `/portal/*`: the route guard
 * said yes, the shell rendered, and then every query failed FORBIDDEN at the
 * service layer. The office does not read one customer's portal — it reads the
 * console, which sees every account at once.
 *
 * ⚠️ `driver:access` is withheld for exactly the same reason, and it is the
 * newer trap of the two. Now that the driver screens live in this app rather
 * than a separate build, a blanket grant would put `/driver` within reach of
 * every administrator — and every read there scopes to the signed-in DRIVER's
 * run. A staff session has no run, so the shell would render and the run sheet
 * behind it would be empty or forbidden. The office watches drivers through the
 * dispatch board (M3), which sees every run at once; it does not borrow one.
 */
const OTHER_SURFACE_CAPABILITIES = new Set<Capability>([
  'portal:access',
  'portal:book',
  'portal:invoices',
  'portal:reports',
  'portal:certificates',
  'portal:supervisors',
  'portal:account',
  'driver:access',
]);

/**
 * Everything a super admin holds — W1 "Global Administrator" — bar the surfaces
 * that belong to someone else's session.
 *
 * Derived by subtraction rather than listed out, so a capability added to
 * `CAPABILITIES` tomorrow reaches the administrator without anyone remembering
 * to come back here. The other-surface set is the only thing ever withheld.
 */
const ALL_ADMIN_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter(
  (capability) => !OTHER_SURFACE_CAPABILITIES.has(capability),
);

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // W1, W2, W3, W4, W5, W7, W8, W14, W15, W16. (W17 backups is automated
  // infrastructure, not a screen — so there is no capability for it.)
  'super-admin': ALL_ADMIN_CAPABILITIES,

  /*
   * Matt's own seat. Everything operational and commercial; nothing that
   * configures the system itself — brands, integrations, notification
   * templates and settings are W3/W5/W7, which are the Administrator's.
   *
   * The one people row here is `users:manage-customers`: onboarding a customer
   * means getting their administrator and supervisors into the portal, and that
   * sits beside `leads:manage` and `accounts:manage` rather than with W1/W16.
   * Staff accounts and role changes remain the Administrator's.
   */
  operations: [
    'admin:access',
    'ops:dashboard',
    'jobs:read',
    'jobs:create',
    'jobs:manage',
    'dispatch:manage',
    'queues:action',
    'driver-comms',
    'notifications:read',
    'accounts:manage',
    'invoices:read',
    'reports:read',
    'certificates:manage',
    'leads:manage',
    'pricing:view',
    'users:manage-customers',
    'drivers:manage',
    'vehicles:manage',
    'audit:read',
    'extractor:use',
  ],

  /*
   * The Office Worker's 16 workflows, read off §12's table:
   *   W46/W48 POs        → queues:action  (manual entry + the AI review queue)
   *   W47/W51/W61        → jobs:read + jobs:manage
   *   W49/W56/W68        → jobs:manage    (documents and comment threads)
   *   W50                → driver-comms
   *   W52/W62/W65/W67    → jobs:manage
   *   W53                → invoices:read  (customer payment history, M7.9)
   *   W59                → certificates:manage
   *
   * No dispatch (that is M3, the allocator's), and nothing that configures the
   * system. Converting a lead is also absent: A.4 sets rates and terms, which is
   * a sales decision, not an intake one.
   */
  'office-staff': [
    'admin:access',
    'ops:dashboard',
    'jobs:read',
    'jobs:create',
    'jobs:manage',
    'queues:action',
    'driver-comms',
    'notifications:read',
    'accounts:manage',
    'invoices:read',
    'reports:read',
    'certificates:manage',
    'pricing:view',
    'extractor:use',
  ],

  /*
   * The Allocator / Driver Manager's 11 workflows, read off §12's table:
   *   W100/W101/W104     → dispatch:manage  (board, run sheets, reassign)
   *   W102               → driver-comms
   *   W108/W111/W120     → jobs:read + dispatch:manage
   *   W122               → jobs:manage      (cancel and reschedule)
   *   W103/W115          → drivers:manage   (F22 driver performance, now in)
   *   W113               → vehicles:manage  (F43 maintenance, now in)
   *
   * ⚠️ NO `pricing:view`. Every one of those eleven workflows is logistics;
   * not one is commercial. The allocator sees the job, the site, the driver and
   * the dates — never what it is worth.
   *
   * ⚠️ NO `queues:action` either. Approving a $90 contamination charge is a
   * commercial decision on a screen built around money, so it cannot be worked
   * usefully by someone who cannot see the amounts. Worth confirming with Matt:
   * a futile pickup is also a slot to re-fill, which is the allocator's problem.
   */
  allocator: [
    'admin:access',
    'ops:dashboard',
    'jobs:read',
    'jobs:manage',
    'dispatch:manage',
    'driver-comms',
    'drivers:manage',
    'vehicles:manage',
    'extractor:use',
  ],

  /*
   * The driver (M4 · W123–W140).
   *
   * Their run sheet, the job screens behind it, the tip-off reconciliation and
   * the defect report — reached at `/driver/*` in THIS app. They previously
   * held nothing at all, because the driver screens were a separate Vite build
   * and a driver signing in here landed on a page explaining they were at the
   * wrong address.
   *
   * ⚠️ No `admin:access`, no `portal:access`, and no `pricing:view`. A driver
   * sees the site, the load and the photos — never what the job is worth, and
   * never another driver's run.
   */
  driver: ['driver:access'],

  /*
   * Customer Administrator — 14 of 15 workflows (W70–W84).
   *
   * Everything in the portal, including the commercial half: invoices (W72,
   * W73), monthly reports (W74, W76, W78, W82), compliance certificates (W84),
   * their own supervisors (W70) and account preferences (W71, W81).
   */
  'customer-administrator': [
    'portal:access',
    'portal:book',
    'portal:invoices',
    'portal:reports',
    'portal:certificates',
    'portal:supervisors',
    'portal:account',
    'pricing:view',
  ],

  /*
   * Customer Site Supervisor — 10 of 14 workflows (W85–W99).
   *
   * ⚠️ NO `pricing:view`, and that is not a preference — M1.5: *"a
   * Customer-Site Supervisor at GJ Gardner can book and view their own site's
   * jobs but cannot see pricing, other sites, or any other builder's work."*
   * The site narrowing is data scoping the SERVER does on the session; this row
   * only decides which screens exist for them.
   */
  'customer-site-supervisor': ['portal:access', 'portal:book'],
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Where a role lands after sign-in.
 *
 * Office and admin roles land on the console, customer roles on the portal.
 * Nobody chooses their surface from a menu; their role already decided it.
 *
 * A driver lands on their run sheet. That used to be an explanation page saying
 * they were in the wrong application — true while the driver screens were a
 * separate build on another port, and the reason the whole surface was folded
 * back in: a browser will only ever install the page it is already on, so an
 * install button for the driver app could not exist anywhere else.
 */
export function landingPathFor(role: Role): string {
  switch (ROLE_SURFACE[role]) {
    case 'admin':
      return '/admin';
    case 'portal':
      return '/portal';
    case 'driver':
      return '/driver';
  }
}

/**
 * The matrix, arranged for reading rather than for checking.
 *
 * ── Why this lives here and not in the settings page ──────────────────────
 * `ROLE_CAPABILITIES` above is the source of truth; this is the same data with
 * a human name and a heading attached. Keeping the two in one file is the point
 * — a capability added to the matrix and not to a group here shows up as a gap
 * in one place, not as a silently missing row on a screen nobody re-reads.
 *
 * ⚠️ Labels are what an administrator would call the thing, not the capability
 * string. `queues:action` means nothing to Matt; "Work the exception queues"
 * does. The capability string stays available as the row's title attribute for
 * whoever is actually debugging a guard.
 */
export const CAPABILITY_GROUPS: ReadonlyArray<{
  title: string;
  /** Shown under the heading — why these belong together. */
  note: string;
  capabilities: ReadonlyArray<{ capability: Capability; label: string }>;
}> = [
  {
    title: 'Where they sign in',
    note: 'A role reaches exactly one surface. This is the first thing to check when someone lands on the wrong screen.',
    capabilities: [
      { capability: 'admin:access', label: 'Admin console' },
      { capability: 'portal:access', label: 'Customer portal' },
      { capability: 'driver:access', label: 'Driver app' },
    ],
  },
  {
    title: 'Jobs and dispatch',
    note: 'The operational half of the console.',
    capabilities: [
      { capability: 'ops:dashboard', label: 'Operations dashboard' },
      { capability: 'jobs:read', label: 'View jobs' },
      { capability: 'jobs:create', label: 'Create a job' },
      { capability: 'jobs:manage', label: 'Edit, cancel and reschedule jobs' },
      { capability: 'dispatch:manage', label: 'Dispatch board and run sheets' },
      { capability: 'queues:action', label: 'Work the exception queues' },
      { capability: 'driver-comms', label: 'Message drivers on a job' },
      { capability: 'extractor:use', label: 'Read purchase orders with the Extractor' },
    ],
  },
  {
    title: 'Money',
    note: 'Withheld from the allocator on purpose: allocation is a logistics decision, so the board shows the job and never what it is worth.',
    capabilities: [
      { capability: 'pricing:view', label: 'See prices, rates and job totals' },
      { capability: 'invoices:read', label: 'Invoices' },
      { capability: 'accounts:manage', label: 'Customer accounts' },
      { capability: 'reports:read', label: 'Reports' },
      { capability: 'certificates:manage', label: 'Compliance certificates' },
      { capability: 'leads:manage', label: 'Leads and onboarding' },
    ],
  },
  {
    title: 'Fleet and people',
    note: 'The allocator manages drivers and vehicles because performance and maintenance are their workflows. Only the administrator manages staff accounts; operations can invite customer users, because that is part of onboarding a customer.',
    capabilities: [
      { capability: 'users:manage', label: 'Users and roles — all seven' },
      { capability: 'users:manage-customers', label: 'Invite customer users only' },
      { capability: 'drivers:manage', label: 'Drivers' },
      { capability: 'vehicles:manage', label: 'Vehicles' },
      { capability: 'notifications:read', label: 'Notification centre and bell' },
    ],
  },
  {
    title: 'Configuration',
    note: 'The administrator alone. These change how the system behaves for everybody, which is why they are one row and not four.',
    capabilities: [
      { capability: 'brands:manage', label: 'Brands' },
      { capability: 'integrations:manage', label: 'Integrations' },
      { capability: 'notifications:manage', label: 'Notification rules' },
      { capability: 'settings:manage', label: 'Settings' },
    ],
  },
  {
    title: 'System',
    note: 'Read-only oversight, plus the design-system showcase.',
    capabilities: [
      { capability: 'audit:read', label: 'Audit log' },
      { capability: 'foundation:view', label: 'Design foundation' },
    ],
  },
  {
    title: 'Customer portal screens',
    note: 'M1.5 word for word: a site supervisor books and views their own site’s jobs but cannot see pricing, other sites, or another builder’s work.',
    capabilities: [
      { capability: 'portal:book', label: 'Book a pickup' },
      { capability: 'portal:invoices', label: 'Invoices' },
      { capability: 'portal:reports', label: 'Reports' },
      { capability: 'portal:certificates', label: 'Certificates' },
      { capability: 'portal:supervisors', label: 'Manage supervisors' },
      { capability: 'portal:account', label: 'Account preferences' },
    ],
  },
];
