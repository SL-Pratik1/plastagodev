import { buttonVariants } from '@plastago/ui';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/**
 * Router-level error boundary. Attached to the root route so a render crash
 * anywhere in the tree still shows the app chrome and a way out, rather than a
 * blank white page.
 *
 * With no error-tracking vendor (§6A.8), an error the user cannot describe is an
 * error we never hear about — so this surfaces enough detail to report.
 */
export function RouteError() {
  const error = useRouteError();

  const title = isRouteErrorResponse(error)
    ? `${String(error.status)} ${error.statusText}`
    : 'Something went wrong';

  const detail =
    isRouteErrorResponse(error) && typeof error.data === 'string'
      ? error.data
      : error instanceof Error
        ? error.message
        : null;

  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {detail && (
        <pre className="overflow-x-auto rounded-md bg-secondary p-3 text-left text-xs text-secondary-foreground">
          {detail}
        </pre>
      )}
      <div className="flex justify-center gap-2">
        <Link to="/" className={buttonVariants({ variant: 'outline' })}>
          Back to start
        </Link>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className={buttonVariants({ variant: 'default' })}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
