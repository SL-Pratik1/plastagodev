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
import {
  ChevronDownIcon,
  ClipboardListIcon,
  LogOutIcon,
  PhoneIcon,
  ScaleIcon,
  TriangleAlertIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandMark } from '@/components/brand/brand-mark';
import { SyncIndicator } from '@/components/driver/sync-indicator';
import { InstallButton } from '@/components/pwa/install-button';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { useAuth, useCurrentUser } from '@/features/auth/auth-context';
import { SessionExpiry } from '@/features/auth/session-expiry';
import { startOutboxSync } from '@/offline/outbox';

/**
 * The driver shell (M4) — one layout, two shapes.
 *
 * ── The phone shape is the one the screens were designed for ──────────────
 * A driver uses this standing beside a truck, one-handed, sometimes in gloves,
 * usually in sun glare, often with no signal. So below `md`:
 *
 *  • **56px tab targets** — well past the 44px minimum, because the failure mode
 *    is a mis-tap that marks the wrong job complete.
 *  • **Four destinations, no more.** Run · Tip-off · Report · Me. Everything else
 *    is reached from a job, because on site the question is always "this job".
 *  • **A fixed bottom bar**, thumb-height, clearing the home indicator.
 *
 * ── Why it also has a desktop shape ───────────────────────────────────────
 * Because `/driver` is a route in a web app that people open on laptops, and a
 * 448px column stranded in the middle of a 1900px window reads as a broken page
 * rather than a deliberate one. Allocators check a driver's run, and drivers
 * themselves sit in the yard with the depot machine.
 *
 * So at `md` and up this becomes the same shape as `AdminShell` and
 * `PortalLayout`: a sidebar rail, a real header with the account menu, and a
 * centred content column — deliberately narrower than the portal's `max-w-6xl`,
 * because these screens are single-column by nature and stretching a run sheet
 * to full width would only put its chevrons a mouse-journey from its addresses.
 *
 * ── Still a third shell, not a variant of the other two ───────────────────
 * The chrome now rhymes with them, but the sync badge is load-bearing here and
 * meaningless there, the tab bar is four fixed destinations rather than a
 * capability-gated menu, and the touch targets are sized for gloves throughout.
 * Folding this into `PortalLayout` would mean every future office affordance
 * needing a "…but not for drivers" branch, which is how a shell rots.
 */
interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  /** `true` where the route would otherwise match its children. */
  end?: boolean;
}

const TABS: readonly Tab[] = [
  { to: '/driver', label: 'Run', icon: ClipboardListIcon, end: true },
  { to: '/driver/tip-off', label: 'Tip-off', icon: ScaleIcon },
  { to: '/driver/report', label: 'Report', icon: TriangleAlertIcon },
  { to: '/driver/me', label: 'Me', icon: UserIcon },
];

export function DriverShell() {
  const driver = useCurrentUser();
  const { signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const [signOutOpen, setSignOutOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  /*
   * The outbox drains for as long as this shell is mounted — which is exactly
   * the driver surface and nothing else.
   *
   * It lived in the old app's root provider, where it had no choice: the whole
   * build WAS the driver app. Here that would mean an office session polling a
   * queue that can never contain anything, every fifteen seconds, all day. The
   * queue is durable in IndexedDB regardless, so anything enqueued survives
   * until a driver session picks it up.
   */
  useEffect(() => startOutboxSync(), []);

  const confirmSignOut = async () => {
    setSigningOut(true);
    try {
      // Leave the guarded tree BEFORE the session goes, exactly as the other two
      // shells do: the moment `RequireAuth` sees an authenticated route without a
      // session it stashes the current path as a `from` for whoever signs in
      // next — and one driver's last job is not the next driver's destination.
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
        href="#driver-main"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-[60] focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>

      {/* Desktop rail. Hidden on phones, where the bottom bar takes over. */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border px-5">
          <NavLink to="/driver" className="focus-ring rounded" aria-label="PlastaGo driver home">
            <BrandMark tone="light" className="h-6" />
          </NavLink>
        </div>

        <div className="border-b border-sidebar-border px-5 py-3">
          <p className="truncate text-sm font-medium">{driver.name}</p>
          <p className="text-xs text-sidebar-muted-foreground">
            {driver.jobTitle ?? ROLE_LABELS[driver.role]}
          </p>
        </div>

        <nav aria-label="Driver" className="min-h-0 flex-1 overflow-y-auto px-2 py-4">
          <ul className="space-y-0.5">
            {TABS.map((tab) => (
              <li key={tab.to}>
                <NavLink
                  to={tab.to}
                  end={tab.end ?? false}
                  className={({ isActive }) =>
                    cn(
                      'focus-ring flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground/85 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
                    )
                  }
                >
                  <tab.icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{tab.label}</span>
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
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-4 md:h-16">
          {/*
            The driver's identity is the phone header's whole left side, because
            there is no rail carrying it there. At `md` the rail takes over and
            this collapses to the brand mark, so the name is never shown twice.
          */}
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground md:hidden">
            PG
          </span>
          <span className="min-w-0 flex-1 md:hidden">
            <span className="block truncate text-sm leading-tight font-semibold">
              {driver.name}
            </span>
            <span className="block text-[11px] leading-tight text-muted-foreground">
              {driver.jobTitle ?? ROLE_LABELS[driver.role]}
            </span>
          </span>

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/*
              Sync state is in the header on EVERY screen and at every width,
              never behind a menu. M4.12 requires the driver to see what has and
              has not synced, and with no error-tracking vendor (§6A.8) they are
              the only person who can tell us the queue is stuck.
            */}
            <SyncIndicator />

            {/*
              Icon-only on a phone, where the word "Install" would push the
              driver's name into an ellipsis; labelled from `sm` up where there
              is room for it to say what it does. Renders nothing at all once the
              app is on the home screen.
            */}
            <InstallButton size="icon" variant="ghost" showLabel={false} className="sm:hidden" />
            <InstallButton
              size="sm"
              variant="ghost"
              label="Install"
              className="hidden sm:inline-flex"
            />

            <ThemeToggle />

            {/*
              Desktop only. On a phone signing out lives on the Me screen, where
              it sits beneath the sync queue on purpose — a driver with unsent
              work is warned before they can leave, and a menu item tucked in the
              header would route around that check.
            */}
            <Menu
              align="end"
              triggerLabel="Account menu"
              triggerClassName="hidden items-center gap-2 rounded-md py-1 pr-2 pl-1 transition-colors hover:bg-muted md:flex"
              trigger={
                <>
                  <Avatar name={driver.name} size="sm" />
                  <span className="hidden text-left lg:block">
                    <span className="block text-sm leading-tight font-medium">{driver.name}</span>
                    <span className="block text-xs leading-tight text-muted-foreground">
                      {ROLE_LABELS[driver.role]}
                    </span>
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                </>
              }
            >
              <div className="px-2.5 py-2">
                <p className="text-sm font-medium">{driver.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {driver.mobile ?? driver.email}
                </p>
                <Badge variant="secondary" className="mt-1.5">
                  {ROLE_LABELS[driver.role]}
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
          id="driver-main"
          key={location.pathname}
          /*
           * `max-w-md` on a phone is the shape the screens were drawn for.
           *
           * `md:max-w-3xl` rather than the portal's `max-w-6xl`: every driver
           * screen is a single column of cards, actions and short forms, so the
           * extra width buys nothing and costs the eye a long trip from an
           * address on the left to its chevron on the right.
           *
           * `pb-24` clears the fixed bottom bar and is dropped at `md` where the
           * bar is gone — without it the last action on every screen sits under
           * the tabs, which reads as a broken layout.
           */
          className="mx-auto w-full max-w-md flex-1 px-4 pt-4 pb-24 sm:px-6 md:max-w-3xl md:pt-6 md:pb-10"
        >
          <Outlet />
        </main>
      </div>

      {/* Phone tab bar. Fixed, glove-sized, and it clears the home indicator. */}
      <nav
        aria-label="Driver"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="flex">
          {TABS.map((tab) => (
            <li key={tab.to} className="flex-1">
              <NavLink
                to={tab.to}
                end={tab.end ?? false}
                className={({ isActive }) =>
                  cn(
                    'focus-ring flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors',
                    isActive ? 'text-primary' : 'text-muted-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <tab.icon
                      aria-hidden
                      className={cn('size-6 shrink-0', isActive && 'stroke-[2.4]')}
                    />
                    {tab.label}
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
        description="Anything still waiting to send stays on this device until you sign back in. You’ll need a new one-time code."
        confirmLabel="Sign out"
        pending={signingOut}
      />
    </div>
  );
}
