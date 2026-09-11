import { Button, buttonVariants } from '@plastago/ui';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';

/**
 * Router error boundary.
 *
 * A driver seeing a blank screen on site will stop using the app and go back to
 * paper. Always show something, and always show a way forward — the queued work
 * in IndexedDB survives a reload, so reloading is safe advice.
 */
export function RouteError() {
  const error = useRouteError();

  /*
   * A wrong address is not a crash, and saying so matters here more than in the
   * console.
   *
   * Both used to land on "Something went wrong" over a Reload button. Reloading
   * a URL that does not exist fails exactly the same way the second time, so the
   * one offered action could never work — and the driver reading it is standing
   * on a site with no way back to their run except the browser's back button.
   * It is reachable from a stale home-screen shortcut or a mistyped link, which
   * on an installed PWA is an ordinary Monday rather than a hypothetical.
   */
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="mx-auto max-w-md space-y-4 px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">That screen does not exist</h1>
        <p className="text-sm text-muted-foreground">
          The address is wrong, so there is nothing to show. Nothing has been lost — your run and
          any queued work are still here.
        </p>
        <Link to="/" className={`${buttonVariants({ size: 'touch' })} w-full`}>
          Back to today’s run
        </Link>
      </div>
    );
  }

  const detail = error instanceof Error ? error.message : 'Unknown error';

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
      <Link to="/" className={`${buttonVariants({ variant: 'secondary', size: 'touch' })} w-full`}>
        Back to today’s run
      </Link>
    </div>
  );
}
