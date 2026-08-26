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
  PanelLeftIcon,
  UserIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand/brand-mark';
import { NotificationsMenu } from '@/components/notifications-menu';
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
import { useAuth, useCurrentUser } from '@/features/auth/auth-context';
import { useQueueCounts } from '@/features/queues/queries';

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
  const { can, signOut } = useAuth();
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
      await signOut();
      setSignOutOpen(false);
      // A toast here earns its place: the page changes to the sign-in screen,
      // which on its own is ambiguous between "signed out" and "session expired".
      toast.success('You’ve been signed out');
      await navigate('/auth/sign-in', { replace: true });
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
          'sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex',
          collapsed ? 'w-[4.75rem]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-16 shrink-0 items-center border-b border-sidebar-border',
            collapsed ? 'justify-center px-2' : 'px-5',
          )}
        >
          <NavLink to="/admin" className="focus-ring rounded" aria-label="PlastaGo admin console">
            {collapsed ? (
              <BrandMark tone="light" variant="mark" className="h-7" decorative />
            ) : (
              <BrandMark tone="light" className="h-6" />
            )}
          </NavLink>
        </div>

        <nav aria-label="Console" className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <NavGroups groups={groups} collapsed={collapsed} />
        </nav>

        <div className="shrink-0 border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            className={cn(
              'focus-ring flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              collapsed && 'justify-center px-0',
            )}
          >
            <PanelLeftIcon
              aria-hidden
              className={cn('size-4 shrink-0 transition-transform', collapsed && 'rotate-180')}
            />
            {!collapsed && <span>Collapse</span>}
            <span className="sr-only">
              {collapsed ? 'Expand navigation' : 'Collapse navigation'}
            </span>
          </button>
        </div>
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
              <MenuSeparator />
              <MenuItem icon={UserIcon} disabled>
                My profile (not built yet)
              </MenuItem>
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
        className="bg-sidebar text-sidebar-foreground"
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
 * The rail, with live counts on the queue links.
 *
 * The counts come from one small polled call shared by every item — not one per
 * link — and a missing or still-loading count renders nothing rather than a
 * placeholder zero. "0" and "not loaded yet" mean opposite things here: the
 * first says the queue is clear, and showing it before it is true is exactly the
 * false reassurance these queues exist to prevent.
 */
function NavGroups({ groups, collapsed }: { groups: readonly NavGroup[]; collapsed: boolean }) {
  const { data: counts } = useQueueCounts();

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
              const count = item.countKey && counts ? counts[item.countKey] : undefined;
              const showCount = count !== undefined && count > 0;

              return (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end ?? false}
                    // The tooltip is the only label when collapsed, so it is not
                    // optional polish — it is the accessible name's backup.
                    title={
                      collapsed
                        ? showCount
                          ? `${item.label} — ${String(count)} waiting`
                          : item.label
                        : undefined
                    }
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
                      <>
                        <span className="sr-only">
                          {item.label}
                          {showCount ? `, ${String(count)} waiting` : ''}
                        </span>
                        {/* A dot, not a number: 190px of rail is gone. */}
                        {showCount && (
                          <span
                            aria-hidden
                            className="absolute top-1.5 right-3 size-1.5 rounded-full bg-warning"
                          />
                        )}
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate">{item.label}</span>
                        {showCount && (
                          <span className="shrink-0 rounded-full bg-sidebar-foreground/15 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums">
                            {count}
                            <span className="sr-only"> waiting</span>
                          </span>
                        )}
                      </>
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
