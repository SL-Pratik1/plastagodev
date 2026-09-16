import { ROLE_LABELS } from '@plastago/shared';
import {
  Avatar,
  Badge,
  ConfirmDialog,
  Drawer,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  cn,
  useToast,
} from '@plastago/ui';
import {
  CheckIcon,
  ChevronDownIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RepeatIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand/brand-mark';
import { NotificationsMenu } from '@/components/notifications-menu';
import { InstallButton } from '@/components/pwa/install-button';
import { SessionExpiry } from '@/features/auth/session-expiry';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import {
  ALL_BRANDS,
  BRAND_STORAGE_KEY,
  brandName,
  brandsFor,
  type BrandSelection,
} from '@/config/brands';
import { visibleNav, type NavGroup } from '@/config/navigation';
import { roleSurfaceHref } from '@/config/surfaces';
import { useAuth, useCurrentUser } from '@/features/auth/auth-context';
import { landingPathFor } from '@/features/auth/permissions';

/**
 * The admin & office console shell (M2).
 *
 * ── Layout decisions, and why ──────────────────────────────────────────────
 * **A persistent left rail, not a top nav.** Eleven destinations do not fit
 * across a top bar without a "More" menu, and the office moves between queues
 * constantly — every navigation should be one click, always in the same place.
 *
 * **The rail is dark green in both themes.** It is the one place the brand
 * appears at size, and it separates navigation from content without a border,
 * so the content area stays the brightest thing on screen — which is where the
 * grids are.
 *
 * **Collapsible to icons, and it remembers.** A 22-screen console competes with
 * wide grids for horizontal space; on a 1366px laptop reclaiming 190px is the
 * difference between seeing a column and scrolling for it.
 *
 * **Below `lg` the rail becomes a drawer.** Not a squeezed rail — a phone needs
 * the whole width for content.
 */
export function AdminShell() {
  const user = useCurrentUser();
  const { can, signOut, switchRole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [collapsed, setCollapsed] = useState(() => readCollapsed());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [brand, setBrand] = useState<BrandSelection>(() => readBrand());

  const groups = visibleNav(can);
  const availableBrands = brandsFor(user.brandIds);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      writeCollapsed(!current);
      return !current;
    });
  };

  const chooseBrand = (next: BrandSelection) => {
    setBrand(next);
    writeBrand(next);
  };

  const confirmSignOut = async () => {
    setSigningOut(true);
    try {
      // Leave the guarded tree BEFORE the session goes. The moment `RequireAuth`
      // sees an authenticated route without a session it stashes the current
      // path as a `from` for whoever signs in next — and one person's last
      // screen is not the next person's destination.
      await navigate('/auth/sign-in', { replace: true, state: null });
      await signOut();
      setSignOutOpen(false);
      // A toast here earns its place: the page changes to the sign-in screen,
      // which on its own is ambiguous between "signed out" and "session expired".
      toast.success('You’ve been signed out');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* First focusable element on the page — bypasses the whole rail. */}
      <a
        href="#main-content"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>

      <aside
        className={cn(
          'scrollbar-on-dark sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex',
          collapsed ? 'w-[4.75rem]' : 'w-64',
        )}
      >
        {/*
          The toggle lives up here beside the wordmark rather than in a row at
          the foot of the rail. It is the control that changes this panel, so it
          belongs at the panel's head where the eye already is when reading the
          logo — and it stops the rail ending in a permanent "Collapse" item that
          looked like a navigation destination among the real ones.
        */}
        <div
          className={cn(
            'flex h-16 shrink-0 items-center border-b border-sidebar-border',
            // Collapsed, the rail is 4.75rem — room for the toggle centred, but
            // not for the mark stacked above it inside a 4rem-tall header. The
            // wordmark returns the moment the rail expands.
            collapsed ? 'justify-center px-2' : 'justify-between gap-2 px-4',
          )}
        >
          {!collapsed && (
            <NavLink to="/admin" className="focus-ring rounded" aria-label="PlastaGo admin console">
              <BrandMark tone="light" className="h-6" />
            </NavLink>
          )}

          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls={NAV_ID}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            className="focus-ring grid size-9 shrink-0 place-items-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            {/*
              Two distinct glyphs rather than one rotated 180°. A rotated panel
              icon reads as the same control pointing somewhere; these two say
              what will happen — the bar closes, or the bar opens.
            */}
            {collapsed ? (
              <PanelLeftOpenIcon aria-hidden className="size-[1.15rem]" />
            ) : (
              <PanelLeftCloseIcon aria-hidden className="size-[1.15rem]" />
            )}
            <span className="sr-only">
              {collapsed ? 'Expand navigation' : 'Collapse navigation'}
            </span>
          </button>
        </div>

        <nav id={NAV_ID} aria-label="Console" className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <NavGroups groups={groups} collapsed={collapsed} />
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={() => {
              setMobileNavOpen(true);
            }}
            className="focus-ring touch-target grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
          >
            <MenuIcon aria-hidden className="size-5" />
            <span className="sr-only">Open navigation</span>
          </button>

          <BrandMark className="h-5 lg:hidden" />

          {/*
            Brand switcher (M1.1). Brand is a dimension on accounts, jobs,
            invoices and templates — not a setting — so which brand you are
            looking at has to be visible at all times, not buried in a filter.
            Hidden when the user only has one, because then it is not a choice.
          */}
          {availableBrands.length > 1 && (
            <Menu
              align="start"
              triggerLabel="Change brand"
              triggerClassName="hidden items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted sm:flex"
              trigger={
                <>
                  <span className="text-muted-foreground">Brand</span>
                  <span>{brandName(brand)}</span>
                  <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </>
              }
            >
              <MenuLabel>Viewing</MenuLabel>
              <MenuItem
                icon={brand === ALL_BRANDS ? CheckIcon : undefined}
                onSelect={() => {
                  chooseBrand(ALL_BRANDS);
                }}
              >
                All brands
              </MenuItem>
              <MenuSeparator />
              {availableBrands.map((option) => (
                <MenuItem
                  key={option.id}
                  icon={brand === option.id ? CheckIcon : undefined}
                  onSelect={() => {
                    chooseBrand(option.id);
                  }}
                >
                  {option.name}
                  {option.status === 'planned' && (
                    <span className="ml-1 text-xs text-muted-foreground">(planned)</span>
                  )}
                </MenuItem>
              ))}
            </Menu>
          )}

          <div className="ml-auto flex items-center gap-1">
            {/*
              The bell counts unactioned queue work (M8.7), and it opens the
              notification centre. A role that cannot reach that screen would get
              a badge it could not act on and a "View all" that 403s — so the
              bell follows the screen it belongs to.
            */}
            {/*
              Installing the console is worth offering, not just the driver app.
              An allocator working the board all day gets it in its own window,
              off the tab strip, with the brand in the title bar — and it is the
              same one-tap install, because this is one app with one manifest.

              Renders nothing once installed, and nothing on a browser that
              cannot install, so no dead control ever appears here.
            */}
            <InstallButton
              size="sm"
              variant="ghost"
              label="Install"
              className="hidden sm:inline-flex"
            />
            {can('notifications:read') && <NotificationsMenu />}
            <ThemeToggle />

            <Menu
              align="end"
              triggerLabel="Account menu"
              triggerClassName="flex items-center gap-2 rounded-md py-1 pr-2 pl-1 transition-colors hover:bg-muted"
              trigger={
                <>
                  <Avatar name={user.name} size="sm" />
                  <span className="hidden text-left sm:block">
                    <span className="block text-sm font-medium leading-tight">{user.name}</span>
                    <span className="block text-xs leading-tight text-muted-foreground">
                      {ROLE_LABELS[user.role]}
                    </span>
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </>
              }
            >
              <div className="px-2.5 py-2">
                <p className="text-sm font-medium">{user.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {user.email ?? user.mobile}
                </p>
                <Badge variant="secondary" className="mt-1.5">
                  {ROLE_LABELS[user.role]}
                </Badge>
              </div>
              {/*
                Only for the rare user who holds more than one role.
                Matt's driver manager is the case: *"if we have a driver that
                calls in sick he'll take over for them for the day"* (27:01).
                Switching leaves this application entirely — the driver surface
                is a different app — so it navigates rather than re-rendering.
              */}
              {user.roles.length > 1 && (
                <>
                  <MenuSeparator />
                  <MenuLabel>Switch role</MenuLabel>
                  {user.roles
                    .filter((held) => held !== user.role)
                    .map((held) => (
                      <MenuItem
                        key={held}
                        icon={RepeatIcon}
                        onSelect={() => {
                          switchRole(held);
                          /*
                           * Each surface has its own origin (Matt, 29:04), so
                           * a switch that crosses one is a page load rather
                           * than a route change. `roleSurfaceHref` returns null
                           * when the target surface is already this one — and
                           * always, in single-server mode — so the ordinary
                           * in-app path is unchanged.
                           */
                          const home = landingPathFor(held);
                          const external = roleSurfaceHref(held, home);
                          if (external !== null) {
                            window.location.assign(external);
                            return;
                          }
                          void navigate(home);
                        }}
                      >
                        Work as {ROLE_LABELS[held].toLowerCase()}
                      </MenuItem>
                    ))}
                </>
              )}
              {/*
                There is no "My profile" item here. There was, disabled, reading
                "(not built yet)" — an admission of an unbuilt screen sitting in
                the menu every office user opens to sign out. Nothing links to a
                profile route and nothing depends on one, so the item is out
                until the screen exists rather than advertising its absence.
              */}
              <MenuSeparator />
              <MenuItem
                icon={LogOutIcon}
                tone="destructive"
                onSelect={() => {
                  setSignOutOpen(true);
                }}
              >
                Sign out
              </MenuItem>
            </Menu>
          </div>
        </header>

        <main
          id="main-content"
          // `key` on the route makes the main region remount per navigation, so
          // scroll position does not carry from a long grid onto a short page.
          key={location.pathname}
          className="mx-auto w-full max-w-[100rem] flex-1 px-4 py-6 sm:px-6 lg:py-8"
        >
          <Outlet />
        </main>

        <footer className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground sm:px-6">
          PlastaGo console · demo build on sample data · all times Australia/Sydney
        </footer>
      </div>

      <Drawer
        open={mobileNavOpen}
        onClose={() => {
          setMobileNavOpen(false);
        }}
        side="left"
        title="Navigation"
        className="scrollbar-on-dark bg-sidebar text-sidebar-foreground"
      >
        <nav
          aria-label="Console"
          onClick={() => {
            // Any link tap should close the drawer — otherwise the new page
            // renders behind an open panel.
            setMobileNavOpen(false);
          }}
        >
          <NavGroups groups={groups} collapsed={false} />
        </nav>
      </Drawer>

      {/* Warns before the 8-hour session lapses, then handles the expiry. */}
      <SessionExpiry />

      <ConfirmDialog
        open={signOutOpen}
        onCancel={() => {
          setSignOutOpen(false);
        }}
        onConfirm={() => void confirmSignOut()}
        title="Sign out of PlastaGo?"
        description="You’ll need a new one-time code to sign back in."
        confirmLabel="Sign out"
        pending={signingOut}
      />
    </div>
  );
}

/**
 * The rail. Links only — no counts.
 *
 * ── Why the badges are gone ───────────────────────────────────────────────
 * They were removed on request, and the Leads badge is the reason why: each
 * badge carried its own private definition of "outstanding", and the Leads one
 * counted anything not lost — so a lead marked won but never converted sat in
 * the rail as work forever, and the rail said 4 while the page it linked to
 * said 3 open. Two numbers for one queue, disagreeing in the same viewport, are
 * worse than no number: the page you land on is the one that can show its
 * working, and now it is the only one that speaks.
 */
function NavGroups({ groups, collapsed }: { groups: readonly NavGroup[]; collapsed: boolean }) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.id} className="space-y-1">
          {collapsed ? (
            <div aria-hidden className="mx-3 mb-2 h-px bg-sidebar-border" />
          ) : (
            <p className="px-3 pb-1 text-[10px] font-semibold tracking-widest text-sidebar-muted-foreground uppercase">
              {group.label}
            </p>
          )}

          <ul className="space-y-0.5">
            {group.items.map((item) => {
              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end ?? false}
                    // The tooltip is the only label when collapsed, so it is not
                    // optional polish — it is the accessible name's backup.
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'focus-ring relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                      )
                    }
                  >
                    <item.icon aria-hidden className="size-4 shrink-0" />
                    {collapsed ? (
                      <span className="sr-only">{item.label}</span>
                    ) : (
                      <span className="flex-1 truncate">{item.label}</span>
                    )}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ── Persisted shell preferences ───────────────────────────────────────────
   Guarded because `localStorage` throws outright when site data is blocked. */

/** Ties the header toggle to the region it expands, for `aria-controls`. */
const NAV_ID = 'console-nav';

const COLLAPSE_KEY = 'plastago.nav.collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, String(value));
  } catch {
    // Preference is lost on reload; the console still works.
  }
}

function readBrand(): BrandSelection {
  try {
    return window.localStorage.getItem(BRAND_STORAGE_KEY) ?? ALL_BRANDS;
  } catch {
    return ALL_BRANDS;
  }
}

function writeBrand(value: BrandSelection): void {
  try {
    window.localStorage.setItem(BRAND_STORAGE_KEY, value);
  } catch {
    // As above.
  }
}
