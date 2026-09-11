import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { LinkIcon, RefreshCwIcon, Unlink2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { useConnectXero, useDisconnectXero, useXeroStatus } from '@/features/xero/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import type { XeroConnectionStatus } from '@/services/types';

/**
 * The Xero page (I1 · M7.8).
 *
 * ── Why this is its own page and not a Settings tab ───────────────────────
 * Settings is where an administrator changes PlastaGo's own behaviour. This is
 * where they bind PlastaGo to somebody else's system — the same kind of thing
 * as the Extractor, which is why the two sit together under Configuration.
 * It also has a state that no settings tab has: it can be broken by an action
 * taken somewhere else entirely, and it has to say so.
 *
 * ── What this page is really for ──────────────────────────────────────────
 * Two jobs, and the second is the one that earns the page. The first is
 * connecting, which happens once. The second is answering "are invoices still
 * reaching the accountant?" — a question whose wrong answer is discovered at
 * month-end, when a fortnight of invoices turn out never to have arrived.
 * Everything below the fold exists to make that answerable at a glance.
 */
export function AdminXeroPage(): React.JSX.Element {
  const status = useXeroStatus();
  const connect = useConnectXero();
  const disconnect = useDisconnectXero();
  const toast = useToast();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [params, setParams] = useSearchParams();

  /*
   * The result of the round trip through Xero arrives as a query string,
   * because the callback is a redirect and has nowhere else to put it.
   *
   * Consumed once and stripped from the URL: leaving it there means a reload
   * or a shared link re-announces a connection that happened yesterday, and
   * "Connected to X" shown next to a broken connection is worse than silence.
   */
  const outcome = params.get('xero');
  const outcomeMessage = params.get('message');

  useEffect(() => {
    if (!outcome) return;

    if (outcome === 'connected') {
      toast.success('Connected to Xero', outcomeMessage ?? undefined);
    } else {
      toast.error('Could not connect to Xero', outcomeMessage ?? undefined);
    }

    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('xero');
        next.delete('message');
        return next;
      },
      { replace: true },
    );
  }, [outcome, outcomeMessage, setParams, toast]);

  const header = (
    <PageHeader
      title="Xero"
      description="Send invoices to Xero automatically and pull payment status back. PlastaGo raises the invoice; Xero keeps the books."
    />
  );

  if (status.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (status.isError) {
    const described = describeError(status.error);
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void status.refetch()}
        />
      </div>
    );
  }

  const data = status.data;

  /*
   * No credentials on this deployment. Said plainly rather than shown as a
   * Connect button that can only fail — a dead button reads as a broken
   * integration, which is a different and more alarming problem than an
   * unconfigured one.
   */
  if (!data.configured) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          title="Xero is not configured on this environment"
          description="Set XERO_PROVIDER=xero and the Xero client credentials in the API environment, then restart the API."
        />
      </div>
    );
  }

  const onConnect = () => {
    connect.mutate(undefined, {
      onError: (error) => {
        const described = describeError(error);
        toast.error(described.title, described.detail);
      },
    });
  };

  const onDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      setConfirmOpen(false);
      toast.success('Disconnected from Xero', 'Invoices will stop syncing until you reconnect.');
    } catch (error) {
      const described = describeError(error);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      {header}

      {/* ── The connection ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            Connection
            <XeroStateBadge state={data.state} />
          </CardTitle>
          <CardDescription>
            Xero has no password PlastaGo can hold. The organisation owner authorises it once, from
            their own Xero login.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {data.state === 'needs-reconnect' && (
            <Alert variant="destructive" title="Invoices are not reaching Xero">
              <p>{data.message ?? 'Xero rejected the connection.'}</p>
              <p className="mt-2">
                Retrying will not fix this — the authorisation itself has gone. Reconnect below.
              </p>
            </Alert>
          )}

          {data.state === 'expiring' && (
            <Alert variant="warning" title="This connection lapses soon">
              Xero ends an authorisation that has gone unused for 60 days
              {data.refreshExpiresAt === null
                ? '.'
                : `, which for this one is ${formatDate(data.refreshExpiresAt)}.`}{' '}
              Reconnect to reset it.
            </Alert>
          )}

          {data.connected || data.organisationName !== null ? (
            <DetailList
              columns={2}
              items={[
                { label: 'Organisation', value: data.organisationName ?? '—' },
                { label: 'Connected by', value: data.connectedByName ?? '—' },
                {
                  label: 'Connected',
                  value: data.connectedAt === null ? '—' : formatDateTime(data.connectedAt),
                },
                {
                  /*
                   * Surfaced because it is the only visible proof the
                   * background token cycle is alive. A connection that has not
                   * refreshed in weeks is one nothing has used — which is
                   * itself the thing worth noticing.
                   */
                  label: 'Last renewed',
                  value: formatRelative(data.lastRefreshAt),
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              PlastaGo is not connected to Xero. Invoices are raised here as normal and every one is
              marked <span className="font-medium">Not sent to Xero</span>.
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={onConnect} disabled={connect.isPending}>
              {connect.isPending ? <Spinner label="Opening Xero" /> : <LinkIcon aria-hidden />}
              {data.organisationName === null ? 'Connect to Xero' : 'Reconnect'}
            </Button>

            <Button variant="outline" onClick={() => void status.refetch()}>
              <RefreshCwIcon aria-hidden />
              Check now
            </Button>

            {data.organisationName !== null && (
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(true);
                }}
                disabled={disconnect.isPending}
              >
                <Unlink2Icon aria-hidden />
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── What the connection actually does ────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>What syncs</CardTitle>
          <CardDescription>
            One direction for invoices, the other for payment. Nothing else crosses.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <DetailList
            columns={1}
            items={[
              {
                label: 'Invoices out',
                value: 'Pushed to Xero when the office marks them Sent. A retry updates the same invoice rather than raising a second one.',
              },
              {
                label: 'Contacts',
                value: 'Matched in Xero by account name, and created there if missing.',
              },
              {
                label: 'Payment in',
                value: 'When an invoice is settled in Xero, PlastaGo moves it from Sent to Paid on its own.',
              },
              {
                label: 'They become',
                value: (
                  <span className="flex items-center gap-2">
                    <Badge variant={data.invoiceStatus === 'DRAFT' ? 'outline' : 'success'}>
                      {data.invoiceStatus}
                    </Badge>
                    <span className="text-muted-foreground">
                      {data.invoiceStatus === 'DRAFT'
                        ? 'in Xero — the accountant approves them there'
                        : 'in Xero — live in the books immediately, with no review'}
                    </span>
                  </span>
                ),
              },
            ]}
          />

          {data.invoiceStatus === 'AUTHORISED' && (
            <Alert variant="warning" title="Invoices go straight into the ledger">
              Nothing reviews them between PlastaGo and the books. Set XERO_INVOICE_STATUS=DRAFT in
              the API environment if the accountant would rather approve them first.
            </Alert>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => {
          setConfirmOpen(false);
        }}
        onConfirm={() => void onDisconnect()}
        title="Disconnect from Xero?"
        description={
          data.organisationName === null
            ? 'Invoices will stop syncing until somebody reconnects.'
            : `Invoices will stop reaching ${data.organisationName} until somebody reconnects. Nothing already in Xero is removed.`
        }
        confirmLabel="Disconnect"
        tone="destructive"
        pending={disconnect.isPending}
      />
    </div>
  );
}

/**
 * The one-word answer, before anybody reads the detail.
 *
 * `expiring` is deliberately a warning and not a success: a connection that
 * works today and lapses on Friday is not the same thing as a healthy one, and
 * a green badge is exactly what stops somebody reading the sentence underneath.
 */
function XeroStateBadge({ state }: { state: XeroConnectionStatus['state'] }): React.JSX.Element {
  switch (state) {
    case 'connected':
      return <Badge variant="success">Connected</Badge>;
    case 'expiring':
      return <Badge variant="warning">Lapsing soon</Badge>;
    case 'needs-reconnect':
      return <Badge variant="destructive">Reconnect needed</Badge>;
    default:
      return <Badge variant="outline">Not connected</Badge>;
  }
}
