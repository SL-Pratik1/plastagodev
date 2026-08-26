import { Badge } from '@plastago/ui';
import { Link, NavLink, Outlet } from 'react-router';

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

interface AppShellProps {
  /** Which surface of the single app this is — admin console or customer portal. */
  surface: string;
  navItems: readonly NavItem[];
}

/**
 * The chrome shared by both surfaces.
 *
 * Admin console and customer portal are ONE Vite app with role-based routing
 * (§6A.5) — they share auth, session and most components, so they share this
 * shell too. Only the nav items and the accent differ.
 */
export function AppShell({ surface, navItems }: AppShellProps) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground text-xs font-bold">
              PG
            </span>
            PlastaGo
          </Link>
          <Badge variant="secondary">{surface}</Badge>

          <nav aria-label={`${surface} navigation`} className="ml-auto flex items-center gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  [
                    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-border px-4 py-4 text-center text-xs text-muted-foreground">
        Scaffold · no business logic yet · all times Australia/Sydney
      </footer>
    </div>
  );
}
