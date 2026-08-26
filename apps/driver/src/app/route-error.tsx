import { Button } from '@plastago/ui';
import { isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * Router error boundary.
 *
 * A driver seeing a blank screen on site will stop using the app and go back to
 * paper. Always show something, and always show a way forward — the queued work
 * in IndexedDB survives a reload, so reloading is safe advice.
 */
export function RouteError() {
  const error = useRouteError();

  const detail = isRouteErrorResponse(error)
    ? `${String(error.status)} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';

  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        Your queued work is saved on this phone. Reloading will not lose it.
      </p>
      <pre className="overflow-x-auto rounded-md bg-secondary p-3 text-left text-xs">{detail}</pre>
      <Button size="touch" className="w-full" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}
