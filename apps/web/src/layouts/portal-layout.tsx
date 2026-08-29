import { ROLE_LABELS } from '@plastago/shared';
import {
  Avatar,
  Badge,
  ConfirmDialog,
  Menu,
  MenuItem,
  MenuSeparator,
  cn,
  useToast,
} from '@plastago/ui';
import { ChevronDownIcon, LogOutIcon, PhoneIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand/brand-mark';
import { InstallButton } from '@/components/pwa/install-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { visiblePortalNav } from '@/config/portal-navigation';
import { SessionExpiry } from '@/features/auth/session-expiry';
import { useAuth, useCurrentUser } from '@/features/auth/auth-context';
import { usePortalScope } from '@/features/portal/queries';

/**
 * The customer portal shell (M5 Part 1).
 *
 * ── Designed for the phone first, and not as a slogan ──────────────────────
 * The primary user is a site supervisor standing on a building site. So:
 *
 *  • **A fixed bottom tab bar below `md`.** Thumb reach is the bottom of a
 *    phone. A hamburger menu would put booking a pickup — the single most
 *    valuable action in the product — behind a tap and a stretch.
 *  • **`safe-area-inset-bottom` padding**, so the bar clears the iPhone home
 *    indicator instead of sitting under it.
 *  • **44px minimum targets** on every tab. Gloves, cold hands, one hand on a
 *    ladder.
 *  • **The office phone number is in the chrome.** The portal exists to reduce
 *    calls, not to trap someone who needs one — and a customer who cannot find
 *    a way to ring is a customer who rings a competitor.
 *
 * Above `md` it becomes a left rail, because the Customer Administrator doing
 * invoices and monthly reports is at a desk with a wide screen.
 */
export function PortalLayout() {
  const user = useCurrentUser();
  const { can, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const scope = usePortalScope();

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const items = visiblePortalNav(can);
  const tabs = items.filter((item) => item.primary);

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
      toast.success('You’ve been signed out');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#portal-main"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to main content
      </a>

      {/* Desktop rail. Hidden on phones, where the bottom bar takes over. */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-5">
          <NavLink to="/portal" className="focus-ring rounded" aria-label="PlastaGo portal home">
            <BrandMark tone="light" className="h-6" />
          </NavLink>
        </div>

        <div className="border-b border-sidebar-border px-5 py-3">
          <p className="truncate text-sm font-medium">{scope.data?.accountName ?? '—'}</p>
          <p className="text-xs text-sidebar-muted-foreground">
            {scope.data ? `${scope.data.customerCode} · ${ROLE_LABELS[user.role]}` : ' '}
          </p>
        </div>

        <nav aria-label="Portal" className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end ?? false}
                  className={({ isActive }) =>
                    cn(
                      'focus-ring flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="shrink-0 border-t border-sidebar-border p-4">
          <a
            href="tel:1300395438"
            className="focus-ring flex items-center gap-2 rounded-md text-xs text-sidebar-muted-foreground transition-colors hover:text-sidebar-accent-foreground"
          >
            <PhoneIcon aria-hidden className="size-3.5 shrink-0" />
            1300 395 438
          </a>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-4 backdrop-blur sm:h-16">
          <BrandMark className="h-5 md:hidden" />

          <span className="min-w-0 md:hidden">
            <span className="block truncate text-xs font-medium">
              {scope.data?.accountName ?? ''}
            </span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* On a phone, calling the office is one tap from anywhere. */}
            <a
              href="tel:1300395438"
              className="focus-ring touch-target grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
              aria-label="Call PlastaGo on 1300 395 438"
            >
              <PhoneIcon aria-hidden className="size-5" />
            </a>

            {/*
              A site supervisor lives on a phone as much as any driver does —
              they book pickups standing on the slab. Installed, the portal opens
              full screen from their home screen instead of through a bookmark.
              Hidden on the narrowest widths only because this header is already
              carrying a call button there.
            */}
            <InstallButton
              size="sm"
              variant="ghost"
              label="Install"
              className="hidden sm:inline-flex"
            />

            <ThemeToggle />

            <Menu
              align="end"
              triggerLabel="Account menu"
              triggerClassName="flex items-center gap-2 rounded-md py-1 pr-2 pl-1 transition-colors hover:bg-muted"
              trigger={
                <>
                  <Avatar name={user.name} size="sm" />
                  <span className="hidden text-left sm:block">
                    <span className="block text-sm leading-tight font-medium">{user.name}</span>
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
          id="portal-main"
          key={location.pathname}
          // `pb-24` clears the fixed bottom bar; it is removed at `md` where the
          // bar is gone. Without it the last row of every list sits under the
          // tabs and looks like a rendering bug.
          className="mx-auto w-full max-w-6xl flex-1 px-4 pt-5 pb-24 sm:px-6 md:pb-8"
        >
          <Outlet />
        </main>
      </div>

      {/* Phone tab bar. Fixed, thumb-height, and it clears the home indicator. */}
      <nav
        aria-label="Portal"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex">
          {tabs.map((item) => (
            <li key={item.to} className="flex-1">
              <NavLink
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  cn(
                    'focus-ring flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-[11px] font-medium transition-colors',
                    isActive ? 'text-primary' : 'text-muted-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      aria-hidden
                      className={cn('size-5 shrink-0', isActive && 'stroke-[2.25]')}
                    />
                    <span className="truncate">{item.shortLabel}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <SessionExpiry />

      <ConfirmDialog
        open={signOutOpen}
        onCancel={() => {
          setSignOutOpen(false);
        }}
        onConfirm={() => void confirmSignOut()}
        title="Sign out?"
        description="You’ll need a new one-time code to sign back in."
        confirmLabel="Sign out"
        pending={signingOut}
      />
    </div>
  );
}
