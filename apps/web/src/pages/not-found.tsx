import { buttonVariants } from '@plastago/ui';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md space-y-4 py-12 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-muted-foreground">That route does not exist in this build.</p>
      <Link to="/" className={buttonVariants({ variant: 'outline' })}>
        Back to start
      </Link>
    </div>
  );
}
