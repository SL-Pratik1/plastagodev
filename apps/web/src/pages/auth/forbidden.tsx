import { ROLE_LABELS } from '@plastago/shared';
import {
  buttonVariants,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@plastago/ui';
import { LockIcon } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { useAuth } from '@/features/auth/auth-context';
import { landingPathFor } from '@/features/auth/permissions';

/**
 * 403.
 *
 * Says which role is signed in and who to ask, because "access denied" with no
 * further information produces a support call every time. It does NOT name the
 * capability that was missing — that is our vocabulary, not the user's; it goes
 * in the route state for developers instead.
 */
export function ForbiddenPage() {
  const { user } = useAuth();
  const location = useLocation();
  const capability = (location.state as { capability?: string } | null)?.capability;

  return (
    <div className="mx-auto max-w-md py-12">
      <Card>
        <CardHeader>
          <div className="mb-1 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <LockIcon aria-hidden className="size-5" />
          </div>
          <CardTitle className="text-lg">You don’t have access to that page</CardTitle>
          <CardDescription>
            {user
              ? `You’re signed in as ${user.name} (${ROLE_LABELS[user.role]}). That role doesn’t include this screen.`
              : 'Sign in to continue.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            If you need it, ask a super admin to update your role.
          </p>

          {/*
            `buttonVariants` on the Link rather than <Button><Link/></Button>: an
            anchor nested inside a button is invalid HTML and breaks keyboard nav.
          */}
          <Link
            to={user ? landingPathFor(user.role) : '/auth/sign-in'}
            className={buttonVariants({ className: 'w-full sm:w-auto' })}
          >
            Back to my home
          </Link>

          {/* Developer breadcrumb — invisible to users, useful in a bug report. */}
          {capability && <p className="sr-only">Missing capability: {capability}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
