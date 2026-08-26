import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface Crumb {
  label: string;
  /** Omit for the current page — the last crumb is never a link. */
  to?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Ancestors only; the current page is appended automatically from `title`. */
  breadcrumbs?: readonly Crumb[];
  /** Status or count beside the title. */
  badge?: ReactNode;
  /** Primary and secondary actions, right-aligned on desktop. */
  actions?: ReactNode;
}

/**
 * The top of every console page.
 *
 * One component so the title, breadcrumb and action row cannot drift between
 * twenty screens — inconsistent page headers are the single most obvious sign of
 * a console assembled by different hands.
 *
 * `<h1>` lives here, exactly once per page, so the heading outline is correct
 * for screen readers and for anyone navigating by heading.
 */
export function PageHeader({ title, description, breadcrumbs, badge, actions }: PageHeaderProps) {
  return (
    <header className="space-y-3">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((crumb) => (
              <li key={crumb.label} className="flex items-center gap-1">
                {crumb.to ? (
                  <Link
                    to={crumb.to}
                    className="focus-ring rounded underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span>{crumb.label}</span>
                )}
                <ChevronRightIcon aria-hidden className="size-3 shrink-0" />
              </li>
            ))}
            <li aria-current="page" className="font-medium text-foreground">
              {title}
            </li>
          </ol>
        </nav>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {badge}
          </div>
          {description !== undefined && description !== null && (
            <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
          )}
        </div>

        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
