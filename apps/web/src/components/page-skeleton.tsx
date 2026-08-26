import { Card, Skeleton } from '@plastago/ui';

/**
 * Suspense fallback while a lazy route chunk downloads.
 *
 * Shaped like a page — a header block and a content card — rather than a centred
 * spinner, so the layout does not jump when the real screen arrives. The shell
 * around it is already on screen, so this only ever fills the content area.
 *
 * Announced once, as a whole, because the individual skeleton shapes are
 * `aria-hidden` decoration.
 */
export function PageSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy className="space-y-6">
      <span className="sr-only">Loading page</span>

      <div className="space-y-2">
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-7 w-16" />
          </Card>
        ))}
      </div>

      <Card className="p-5">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} className="h-4 w-full" />
          ))}
        </div>
      </Card>
    </div>
  );
}
