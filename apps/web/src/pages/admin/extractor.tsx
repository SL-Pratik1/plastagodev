import { EmptyState, ErrorState, Skeleton, Spinner } from '@plastago/ui';
import { PageHeader } from '@/components/page-header';
import { EXTRACTOR_ENABLED, extractorEmbedUrl } from '@/config/extractor';
import { useExtractorSession, useExtractorSessionReset } from '@/features/extractor/queries';

/**
 * The Extractor tab (I6 · M2.12).
 *
 * ── Why this screen is a frame and not a rebuild ──────────────────────────
 * Everything inside it — the upload dropzone, the template editor, the mailbox
 * connection, the activity log — is the vendor's own product, and rebuilding it
 * against their REST API would mean maintaining a second UI for someone else's
 * feature set. Every template field they add would be a PlastaGo release.
 *
 * ── Why PlastaGo adds no chrome of its own ────────────────────────────────
 * The frame has its own tab strip, and this page briefly had a second one
 * wrapped around it — two rows of tabs that could disagree about which section
 * was open. The page now contributes a heading and nothing else. Anything that
 * looks like part of the extractor should BE part of the extractor.
 *
 * ── What the frame cannot do, and where that work lives ───────────────────
 * The page runs on the vendor's origin, so nothing in it can see a PlastaGo
 * account, a zone or a job. Deciding which customer a purchase order belongs to
 * — and therefore who gets invoiced — cannot happen in here.
 *
 * ── Why the session is not in this component's state ──────────────────────
 * A remount must not mint a new session at a third party. It is a React Query
 * entry keyed on its own expiry, so navigating away and coming back reuses the
 * one session until it is genuinely near expiry.
 */
export function AdminExtractorPage(): React.JSX.Element {
  const session = useExtractorSession();
  const reset = useExtractorSessionReset();

  const header = (
    <PageHeader
      title="Extractor"
      description="Read purchase orders off a PDF, manage the templates that tell the AI what to look for, and see what has arrived from the mailbox."
    />
  );

  /*
   * No URL configured. Said plainly rather than rendered as an empty frame,
   * which would read as a broken integration rather than an absent one.
   */
  if (!EXTRACTOR_ENABLED) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="The Extractor is not configured"
          description="Set VITE_EXTRACTOR_URL in the web app's environment to the extractor's base URL, then reload."
        />
      </div>
    );
  }

  if (session.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label="Connecting to the Extractor" />
          Connecting to the Extractor…
        </div>
        <Skeleton className="h-[75vh] w-full rounded-lg" />
      </div>
    );
  }

  if (session.error || !session.data) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Could not open the Extractor"
          description={messageFor(session.error)}
          /*
           * Retry DISCARDS the cached session before asking for another.
           *
           * Without that, the retry would be handed back the same stored
           * session id that just failed — the server reuses a cached row until
           * it nears expiry — and the button would appear to do nothing. This
           * is also the recovery path for a session that died inside the frame,
           * which the page cannot detect on its own: a cross-origin iframe does
           * not report its own errors.
           */
          onRetry={() => {
            void reset.mutateAsync().catch(() => undefined);
          }}
        />
      </div>
    );
  }

  const src = extractorEmbedUrl(session.data.sessionId);

  return (
    <div className="space-y-6">
      {header}

      {src ? (
        <iframe
          src={src}
          title="Extractor"
          className="h-[80vh] w-full rounded-lg border border-border bg-background"
          /*
           * `clipboard-write` is what the vendor's guide asks for — their UI
           * offers copy buttons on extracted values. Nothing else is granted:
           * this frame has no reason to reach a camera, a microphone or the
           * device's location.
           */
          allow="clipboard-write"
        />
      ) : null}
    </div>
  );
}

/**
 * The user-facing reason.
 *
 * The API already writes messages the office can act on — "your account needs
 * an email address", "the extractor refused your account" — so this passes them
 * through rather than replacing them with a generic line. The fallback covers a
 * transport failure, which has no server message at all.
 */
function messageFor(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'The Extractor could not be reached. Check your connection and try again.';
}
