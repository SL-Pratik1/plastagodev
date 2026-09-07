import { Badge, cn, useToast } from '@plastago/ui';
import {
  ClipboardListIcon,
  LogOutIcon,
  ScaleIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth, useDriver } from '@/features/auth/auth-context';
import { useOutboxSummary } from '@/offline/use-offline-state';

/**
 * The driver shell.
 *
 * ── The constraints are physical, not stylistic ────────────────────────────
 * A driver uses this standing beside a truck, one-handed, sometimes in gloves,
 * usually in sun glare, often with no signal. So:
 *
 *  • **56px tab targets** — well past the 44px minimum, because the failure mode
 *    is a mis-tap that marks the wrong job complete.
 *  • **Three destinations, no more.** Run · Tip-off · Report. Everything else
 *    is reached from a job, because on site the question is always "this job".
 *  • **Sign out lives in the header**, because with the Me screen gone it is the
 *    only way out. It keeps the unsent-work guard that screen carried: a driver
 *    with a queue is warned before they can leave, because signing out with work
 *    still on the phone is how site evidence gets lost.
 *  • **`max-w-md` on a wide screen.** It is a phone app; looking narrow on a
 *    desktop browser is the correct trade, not a bug.
 */
interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  /** `true` where the route would otherwise match its children. */
  end?: boolean;
}

const TABS: readonly Tab[] = [
  { to: '/', label: 'Run', icon: ClipboardListIcon, end: true },
  { to: '/tip-off', label: 'Tip-off', icon: ScaleIcon },
  { to: '/report', label: 'Report', icon: TriangleAlertIcon },
];

export function DriverLayout() {
  const driver = useDriver();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { signOut } = useAuth();
  const { pending, failed } = useOutboxSummary();

  const leave = async () => {
    // Blocked, not warned. Photos, positions and timestamps taken on site cannot
    // be recreated, and a signed-out phone is where they would stay.
    if (pending > 0 || failed > 0) {
      toast.error(
        'You still have work to send',
        'Stay signed in until it has all gone through, or it stays on this phone.',
      );
      return;
    }
    await signOut();
    await navigate('/sign-in', { replace: true });
  };

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col bg-canvas">
      <a
        href="#driver-main"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
          PG
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm leading-tight font-semibold">{driver.name}</span>
          <span className="block text-[11px] leading-tight text-muted-foreground">
            {driver.jobTitle ?? 'Driver'}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void leave()}
          aria-label="Sign out"
          className="focus-ring ml-auto grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground"
        >
          <LogOutIcon aria-hidden className="size-5" />
        </button>
      </header>

      <main
        id="driver-main"
        key={location.pathname}
        // `pb-24` clears the fixed tab bar. Without it the last action on every
        // screen sits under the tabs, which reads as a broken layout.
        className="flex-1 px-4 pt-4 pb-24"
      >
        <Outlet />
      </main>

      <nav
        aria-label="Driver app"
        className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-md border-t border-border bg-card"
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
                    'focus-ring flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold',
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
    </div>
  );
}

/** Shown on the sign-in screen, which has no shell. */
export function AuthLayout() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center bg-canvas px-5 py-8">
      <div className="mb-6 flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          PG
        </span>
        <div>
          <p className="font-display text-lg leading-tight font-semibold">PlastaGo Driver</p>
          <p className="text-xs text-muted-foreground">Run sheets · photos · weights</p>
        </div>
        <Badge variant="secondary" className="ml-auto">
          Works offline
        </Badge>
      </div>
      <Outlet />
    </div>
  );
}
