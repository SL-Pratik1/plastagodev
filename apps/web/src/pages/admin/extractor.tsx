import {
  Alert,
  Button,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
} from '@plastago/ui';
import { RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/page-header';
import {
  EXTRACTOR_ENABLED,
  EXTRACTOR_PAGES,
  extractorEmbedUrl,
  type ExtractorPageId,
} from '@/config/extractor';
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
 * ── What the frame cannot do, and where that work lives ───────────────────
 * The page runs on the vendor's origin, so nothing in it can see a PlastaGo
 * account, a zone or a job. Deciding which customer a purchase order belongs to
 * — and therefore who gets invoiced — cannot happen in here. That is why the
 * webhook pipeline and the review queue exist on our side.
 *
 * ── Why the session is not in this component's state ──────────────────────
 * A remount must not mint a new session at a third party. It is a React Query
 * entry keyed on its own expiry, so switching tabs, navigating away and coming
 * back all reuse the one session until it is genuinely near expiry.
 */
export function AdminExtractorPage(): React.JSX.Element {
  /*
   * The tab lives in the URL so a colleague can be sent a link to the activity
   * log rather than "open Extractor, then click the fourth tab".
   */
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');

  const [fallbackTab, setFallbackTab] = useState<ExtractorPageId>('upload');
  const tab = isPageId(requested) ? requested : fallbackTab;

  const session = useExtractorSession();
  const reset = useExtractorSessionReset();

  const setTab = (value: string): void => {
    if (!isPageId(value)) return;
    setFallbackTab(value);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set('tab', value);
        return next;
      },
      { replace: true },
    );
  };

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
        <Skeleton className="h-[70vh] w-full rounded-lg" />
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
          onRetry={() => void session.refetch()}
        />
      </div>
    );
  }

  const src = extractorEmbedUrl(tab, session.data.sessionId);

  return (
    <div className="space-y-6">
      {header}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Extractor sections">
          {EXTRACTOR_PAGES.map((page) => (
            <TabsTrigger key={page.id} value={page.id}>
              {page.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {EXTRACTOR_PAGES.map((page) => (
          <TabsPanel key={page.id} value={page.id}>
            {/*
              One frame per tab, mounted only while its tab is selected.

              The alternative — a single frame whose `src` changes — reloads the
              vendor's app on every tab click, and an in-progress upload would
              be lost by switching to Documents and back. Keying on the page id
              means each tab keeps its own scroll position and state for as long
              as the panel is mounted.
            */}
            {page.id === tab && src ? (
              <iframe
                key={page.id}
                src={src}
                title={`Extractor — ${page.label}`}
                className="h-[75vh] w-full rounded-lg border border-border bg-background"
                /*
                 * `clipboard-write` is what the vendor's guide asks for — their
                 * UI offers copy buttons on extracted values. Nothing else is
                 * granted: this frame has no reason to reach a camera, a
                 * microphone or the device's location.
                 */
                allow="clipboard-write"
              />
            ) : null}
          </TabsPanel>
        ))}
      </Tabs>

      {/*
        ⚠️ The one failure this page cannot see.

        A cross-origin frame does not report its own errors, so if the session
        dies inside it the vendor renders "Invalid session" and this page still
        believes everything is fine. There is no event to listen for — hence a
        visible button rather than automatic recovery.
      */}
      <Alert variant="info" title="Seeing “invalid session” inside the panel?">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Sessions last a day. Reconnecting mints a new one and reloads the panel.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void reset.mutateAsync().catch(() => undefined)}
            disabled={reset.isPending}
          >
            {reset.isPending ? <Spinner label="Reconnecting" /> : <RotateCcwIcon aria-hidden />}
            Reconnect
          </Button>
        </div>
      </Alert>
    </div>
  );
}

function isPageId(value: string | null): value is ExtractorPageId {
  return value !== null && EXTRACTOR_PAGES.some((page) => page.id === value);
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
