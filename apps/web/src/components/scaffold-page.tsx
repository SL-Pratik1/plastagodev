import { Alert, Badge, Card, CardContent, CardHeader, CardTitle } from '@plastago/ui';
import { CheckIcon, type LucideIcon } from 'lucide-react';
import { PageHeader, type Crumb } from './page-header';

export interface ScaffoldPageProps {
  title: string;
  description: string;
  breadcrumbs?: readonly Crumb[];
  icon?: LucideIcon;
  /** Scope references this screen answers to, e.g. `['M2.8 · W8']`. */
  scope: readonly string[];
  /** The sections or tabs this screen will contain when it is built. */
  planned: readonly string[];
  /** Anything worth flagging before the screen is designed in detail. */
  note?: string;
}

/**
 * A route that exists but is not built yet.
 *
 * ── Why this component rather than an empty page or a stub ─────────────────
 * The scaffold's own convention, carried over from its admin layout: *"stub links would
 * read as features that exist"*. That risk is sharper here than usual, because
 * a complete-looking UI at this stage will be read as a nearly-complete system
 * (§13.6). So each unbuilt route says plainly that it is a route and not a
 * screen, and lists what it will hold and which part of the scope it answers to.
 *
 * That makes the navigation walkable in a demo — every link goes somewhere and
 * explains itself — without a single screen implying work that has not happened.
 * Replace one of these with a real page and delete nothing else.
 */
export function ScaffoldPage({
  title,
  description,
  breadcrumbs,
  scope,
  planned,
  note,
}: ScaffoldPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        breadcrumbs={breadcrumbs}
        badge={<Badge variant="outline">Not built yet</Badge>}
      />

      <Alert variant="neutral" title="This route is scaffolded, not implemented">
        The application shell, navigation, permissions and shared components are in place. This
        screen’s content is the next phase of work.
      </Alert>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Planned content</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {planned.map((item) => (
                <li key={item} className="flex gap-2 text-muted-foreground">
                  <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Scope reference</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1.5 text-sm">
              {scope.map((item) => (
                <li key={item} className="font-mono text-xs text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
            {note && (
              <p className="border-t border-border pt-3 text-sm text-muted-foreground">{note}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
