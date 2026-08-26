import {
  CHARGE_CODE_LABELS,
  EXCEPTION_REASON_LABELS,
  EXCEPTION_REASONS,
  FREIGHT_ITEM_LABELS,
  ZONE_LABELS,
  type ExceptionReason,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTrigger,
  Textarea,
  useToast,
} from '@plastago/ui';
import {
  BanIcon,
  CalendarIcon,
  FileIcon,
  ImageIcon,
  MapPinIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import {
  AtRiskBadge,
  JobInvoiceBadge,
  JobStatusBadge,
  UrgentBadge,
} from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import { useAuth } from '@/features/auth/auth-context';
import { JobCommentThreads } from '@/features/jobs/components/comment-thread';
import { useCancelJob, useJob, useRescheduleJob } from '@/features/jobs/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDate, formatDateTime, formatMoney, formatWeight } from '@/lib/format';

const TABS = [
  'overview',
  'timeline',
  'charges',
  'photos',
  'documents',
  'comments',
  'invoice',
  'exceptions',
] as const;
type TabKey = (typeof TABS)[number];

const TERMINAL = ['completed', 'admin-complete', 'cancelled'] as const;

/**
 * One job (M2.3).
 *
 * The full record: all parties, the site, the timeline of status changes with
 * timestamps and actors, m² and weight, itemised charges, photos, documents,
 * comments, exceptions and the linked invoice.
 *
 * ── Two things the tabs are careful about ──────────────────────────────────
 *  • **m² and kg are shown as different quantities**, never as two units of one
 *    thing. m² is the board installed and what gets priced; kg is the waste
 *    actually recovered. Accounts configured m²-only show no weight at all
 *    rather than a zero, because a zero reads as "we collected nothing".
 *  • **Charges carry their provenance.** A driver-raised charge shows who raised
 *    it and how many photos back it, because that is what turns a disputed $90
 *    into a paid $90.
 */
export function AdminJobDetailPage() {
  const { jobId } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const { can } = useAuth();
  const { data: job, error, isPending, refetch } = useJob(jobId);
  const cancelJob = useCancelJob();
  const rescheduleJob = useRescheduleJob();

  /*
   * ── The Allocator sees the job, not the price (M1.5) ──────────────────────
   * Two whole tabs are commercial — Charges and Invoice — so they are removed
   * rather than emptied: a tab that opens onto "you cannot see this" is worse
   * than no tab, because it advertises exactly what it withholds.
   *
   * ⚠️ This is a UI courtesy, not a security boundary. The server must scope
   * what it returns; a role that cannot see money still receives `totalExGst`
   * in this build because the mock has no per-role projection.
   */
  const seesPricing = can('pricing:view');

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState<ExceptionReason>('customer-request');
  const [cancelNote, setCancelNote] = useState('');
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [newReadyDate, setNewReadyDate] = useState('');

  const visibleTabs: readonly TabKey[] = seesPricing
    ? TABS
    : TABS.filter((key) => key !== 'charges' && key !== 'invoice');

  // A typed or bookmarked `?tab=charges` falls back to the overview rather than
  // rendering a panel whose trigger is not on the page.
  const rawTab = params.get('tab');
  const tab: TabKey = (visibleTabs as readonly string[]).includes(rawTab ?? '')
    ? (rawTab as TabKey)
    : 'overview';

  const setTab = (next: string) => {
    setParams(
      (current) => {
        const nextParams = new URLSearchParams(current);
        if (next === 'overview') nextParams.delete('tab');
        else nextParams.set('tab', next);
        return nextParams;
      },
      { replace: true },
    );
  };

  const breadcrumbs = [{ label: 'Jobs', to: '/admin/jobs' }];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Job" breadcrumbs={breadcrumbs} />
        <Card>
          <ErrorState
            title={described.title}
            description={described.detail}
            onRetry={() => void refetch()}
          />
        </Card>
      </div>
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-40 w-full" />
        </Card>
      </div>
    );
  }

  const isTerminal = (TERMINAL as readonly string[]).includes(job.status);
  const atRisk =
    !isTerminal &&
    job.status !== 'futile' &&
    job.targetDate <= new Date().toISOString().slice(0, 10);
  const capturesWeight = job.recoveredWeightKg !== null;

  const doCancel = async () => {
    try {
      await cancelJob.mutateAsync({ id: job.id, reason: cancelReason, note: cancelNote });
      toast.success(
        `Job #${String(job.jobNumber)} cancelled`,
        EXCEPTION_REASON_LABELS[cancelReason],
      );
      setCancelOpen(false);
      setCancelNote('');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const doReschedule = async () => {
    try {
      await rescheduleJob.mutateAsync({ id: job.id, readyDate: newReadyDate });
      toast.success(
        'Ready date updated',
        `Target date recalculated from ${formatDate(newReadyDate)}.`,
      );
      setRescheduleOpen(false);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Job #${String(job.jobNumber)}`}
        breadcrumbs={breadcrumbs}
        description={`${job.accountName} · ${job.siteName}, ${job.suburb}`}
        badge={
          <span className="flex flex-wrap items-center gap-1.5">
            <JobStatusBadge status={job.status} />
            {job.serviceLevel === 'urgent' && <UrgentBadge />}
            {atRisk && <AtRiskBadge />}
          </span>
        }
        actions={
          !isTerminal ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setNewReadyDate(job.readyDate);
                  setRescheduleOpen(true);
                }}
              >
                <CalendarIcon aria-hidden />
                Reschedule
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setCancelOpen(true);
                }}
              >
                <BanIcon aria-hidden />
                Cancel job
              </Button>
            </>
          ) : undefined
        }
      />

      {job.status === 'futile' && (
        <Alert variant="destructive" title="Futile pickup">
          The driver attended and could not collect
          {job.exceptionReason ? ` — ${EXCEPTION_REASON_LABELS[job.exceptionReason]}` : ''}. A $120
          futile fee applies whether the job is rescheduled or cancelled, and the photos and GPS on
          the exceptions tab are what make that stand up.
        </Alert>
      )}

      {job.invoiceStatus === 'awaiting-po' && (
        <Alert variant="warning" title="Approved charges are waiting on a PO">
          The base invoice is not held up by this. Additional charges are invoiced separately once
          the customer issues a purchase order for them.
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Job sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline" badge={job.events.length}>
            Timeline
          </TabsTrigger>
          {seesPricing && (
            <TabsTrigger value="charges" badge={job.charges.length || undefined}>
              Charges
            </TabsTrigger>
          )}
          <TabsTrigger value="photos" badge={job.photos.length || undefined}>
            Photos
          </TabsTrigger>
          <TabsTrigger value="documents" badge={job.documents.length || undefined}>
            Documents
          </TabsTrigger>
          <TabsTrigger value="comments" badge={job.comments.length || undefined}>
            Comments
          </TabsTrigger>
          {seesPricing && <TabsTrigger value="invoice">Invoice</TabsTrigger>}
          <TabsTrigger value="exceptions">Exceptions</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsPanel value="overview">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Job</CardTitle>
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    {
                      label: 'Account',
                      value: (
                        <Link
                          to={`/admin/customers/${job.accountId}`}
                          className="focus-ring rounded text-primary underline-offset-4 hover:underline"
                        >
                          {job.accountName}
                        </Link>
                      ),
                    },
                    { label: 'Builder on site', value: job.builderName },
                    { label: 'Site', value: `${job.siteName}, ${job.suburb}` },
                    { label: 'Zone', value: ZONE_LABELS[job.zone] },
                    { label: 'Customer reference', value: job.customerReference ?? '—' },
                    { label: 'Purchase order', value: job.poNumber ?? 'Not supplied' },
                    { label: 'Ready date', value: formatDate(job.readyDate) },
                    {
                      label: 'Target date',
                      value: (
                        <span className={atRisk ? 'font-medium text-destructive' : undefined}>
                          {formatDate(job.targetDate)}
                        </span>
                      ),
                    },
                    { label: 'Freight item', value: FREIGHT_ITEM_LABELS[job.freightItem] },
                    { label: 'Driver', value: job.driverName ?? 'Unallocated' },
                    { label: 'Notes', value: job.notes || '—', wide: true },
                  ]}
                />
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Quantities</CardTitle>
                </CardHeader>
                <CardContent>
                  <DetailList
                    columns={1}
                    items={[
                      { label: 'Expected area', value: formatArea(job.expectedAreaM2) },
                      { label: 'Recycling bags', value: job.bagCount },
                      // Only shown where the account captures it — a zero would
                      // read as "we recovered nothing", which is not the same
                      // thing as "we do not measure it here".
                      ...(capturesWeight
                        ? [
                            {
                              label: 'Recovered weight',
                              value: formatWeight(job.recoveredWeightKg),
                            },
                          ]
                        : []),
                      {
                        label: 'Time on site',
                        value:
                          job.onSiteMinutes === null
                            ? '—'
                            : `${String(job.onSiteMinutes)} min (Arrived → Complete)`,
                      },
                    ]}
                  />
                </CardContent>
              </Card>

              {seesPricing && (
                <Card>
                  <CardHeader>
                    <CardTitle>Value</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <dl className="space-y-1 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Ex GST</dt>
                        <dd className="font-medium tabular-nums">{formatMoney(job.totalExGst)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">GST</dt>
                        <dd className="tabular-nums">{formatMoney(job.gst)}</dd>
                      </div>
                      <div className="flex justify-between border-t border-border pt-1.5">
                        <dt className="font-medium">Inc GST</dt>
                        <dd className="font-display text-lg font-semibold tabular-nums">
                          {formatMoney(job.totalIncGst)}
                        </dd>
                      </div>
                    </dl>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </TabsPanel>

        {/* ── Timeline ─────────────────────────────────────────────────── */}
        <TabsPanel value="timeline">
          <Card>
            <CardHeader>
              <CardTitle>Status history</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 border-l border-border pl-5">
                {job.events.map((event) => (
                  <li key={event.id} className="relative">
                    <span
                      aria-hidden
                      className="absolute top-1.5 -left-[1.4rem] size-2 rounded-full bg-brand-500 ring-2 ring-card"
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <p className="text-sm font-medium">{event.label}</p>
                      {event.status && <JobStatusBadge status={event.status} />}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(event.at)} · {event.actor}
                      {/* M4.2 — driver status changes carry a position. */}
                      {event.latitude !== null && event.longitude !== null && (
                        <span className="ml-1 inline-flex items-center gap-1">
                          <MapPinIcon aria-hidden className="size-3" />
                          {event.latitude.toFixed(4)}, {event.longitude.toFixed(4)}
                        </span>
                      )}
                    </p>
                    {event.detail && (
                      <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Charges ──────────────────────────────────────────────────── */}
        <TabsPanel value="charges">
          <Card>
            <CardHeader>
              <CardTitle>Itemised charges</CardTitle>
            </CardHeader>
            <CardContent>
              {job.charges.length === 0 ? (
                <EmptyState
                  title="No charges yet"
                  description="Charges are raised on completion."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Charges for job {job.jobNumber}</caption>
                    <thead>
                      <tr className="border-b border-border">
                        <th
                          scope="col"
                          className="py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Charge
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Qty
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Rate
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-right text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Amount
                        </th>
                        <th
                          scope="col"
                          className="py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                          Raised by
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {job.charges.map((charge) => (
                        <tr key={charge.id} className="border-b border-border">
                          <td className="py-2.5">
                            <span className="block">{charge.description}</span>
                            <span className="block text-xs text-muted-foreground">
                              {CHARGE_CODE_LABELS[charge.code]}
                            </span>
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {charge.quantity.toLocaleString('en-AU')}
                          </td>
                          <td className="py-2.5 text-right tabular-nums">
                            {formatMoney(charge.unitRate)}
                          </td>
                          <td className="py-2.5 text-right font-medium tabular-nums">
                            {formatMoney(charge.amount)}
                          </td>
                          <td className="py-2.5">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="outline">
                                {charge.source === 'driver'
                                  ? (charge.raisedBy ?? 'Driver')
                                  : charge.source === 'system'
                                    ? 'System'
                                    : 'Office'}
                              </Badge>
                              {charge.approvalState === 'pending' && (
                                <Badge variant="warning">Pending</Badge>
                              )}
                              {charge.approvalState === 'approved' && (
                                <Badge variant="success">Approved</Badge>
                              )}
                              {charge.photoCount > 0 && (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <ImageIcon aria-hidden className="size-3" />
                                  {charge.photoCount}
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} className="py-2.5 text-right text-sm font-medium">
                          Total ex GST
                        </td>
                        <td className="py-2.5 text-right font-display font-semibold tabular-nums">
                          {formatMoney(job.totalExGst)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {job.charges.some((charge) => charge.approvalState === 'pending') && (
                <Alert variant="warning" title="Charges awaiting approval" className="mt-4">
                  Driver and system charges are approved by the office before they can be invoiced.
                  The photo evidence sits against each one.
                </Alert>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Photos ───────────────────────────────────────────────────── */}
        <TabsPanel value="photos">
          <Card>
            <CardHeader>
              <CardTitle>Site photos</CardTitle>
            </CardHeader>
            <CardContent>
              {job.photos.length === 0 ? (
                <EmptyState
                  icon={ImageIcon}
                  title="No photos yet"
                  description="Photos are captured by the driver on site and upload when signal returns."
                />
              ) : (
                <>
                  <p className="mb-4 text-sm text-muted-foreground">
                    Their protocol: front of site, the pile before, the pile after, the site closed
                    — and if it cannot be closed, the cars still on site. That last one is
                    commercial defence against being blamed for leaving a site open.
                  </p>
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {job.photos.map((photo) => (
                      <li
                        key={photo.id}
                        className="overflow-hidden rounded-lg border border-border"
                      >
                        {/*
                          No image source in a UI-only build. A labelled
                          placeholder is honest; a stock photo of a building site
                          would imply data we do not have.
                        */}
                        <div className="grid aspect-4/3 place-items-center bg-muted text-muted-foreground">
                          <ImageIcon aria-hidden className="size-6" />
                        </div>
                        <div className="p-2">
                          <p className="truncate text-xs font-medium">{photo.caption}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatDateTime(photo.takenAt)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Documents ────────────────────────────────────────────────── */}
        <TabsPanel value="documents">
          <Card>
            <CardHeader>
              <CardTitle>Documents</CardTitle>
            </CardHeader>
            <CardContent>
              {job.documents.length === 0 ? (
                <EmptyState
                  icon={FileIcon}
                  title="No documents attached"
                  description="Purchase orders, SWMS packs and weighbridge dockets appear here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {job.documents.map((document) => (
                    <li key={document.id} className="flex items-center gap-3 py-3">
                      <FileIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{document.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatDateTime(document.uploadedAt)} · {document.uploadedBy} ·{' '}
                          {document.sizeKb} KB
                        </p>
                      </div>
                      <Badge variant="outline">{document.kind.replace(/-/g, ' ')}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Comments ─────────────────────────────────────────────────── */}
        <TabsPanel value="comments">
          <JobCommentThreads job={job} />
        </TabsPanel>

        {/* ── Invoice ──────────────────────────────────────────────────── */}
        <TabsPanel value="invoice">
          <Card>
            <CardHeader>
              <CardTitle>Invoicing</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <DetailList
                columns={2}
                items={[
                  { label: 'State', value: <JobInvoiceBadge status={job.invoiceStatus} /> },
                  {
                    label: 'Invoice number',
                    value:
                      job.invoiceNumber === null ? 'Not issued' : `#${String(job.invoiceNumber)}`,
                  },
                  { label: 'Issued', value: formatDateTime(job.invoicedAt) },
                  { label: 'Purchase order', value: job.poNumber ?? 'Not supplied' },
                  { label: 'Total ex GST', value: formatMoney(job.totalExGst) },
                  { label: 'Total inc GST', value: formatMoney(job.totalIncGst) },
                ]}
              />

              <Alert variant="info" title="How this account is invoiced">
                The base invoice goes out on completion against the original PO. Additional charges
                are invoiced separately once their own PO arrives — so cash for the job itself is
                never delayed by a second approval.
              </Alert>
            </CardContent>
          </Card>
        </TabsPanel>

        {/* ── Exceptions ───────────────────────────────────────────────── */}
        <TabsPanel value="exceptions">
          <Card>
            <CardHeader>
              <CardTitle>Exceptions</CardTitle>
            </CardHeader>
            <CardContent>
              {job.exceptionReason === null ? (
                <EmptyState
                  icon={TriangleAlertIcon}
                  title="No exceptions"
                  description="Delays, futile pickups, contamination and cancellations appear here with their reason codes."
                />
              ) : (
                <DetailList
                  columns={2}
                  items={[
                    { label: 'Reason', value: EXCEPTION_REASON_LABELS[job.exceptionReason] },
                    {
                      label: 'Recorded',
                      value: job.status === 'futile' ? 'On site by driver' : 'By office',
                    },
                    { label: 'Note', value: job.exceptionNote ?? '—', wide: true },
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      {/* ── Reschedule ───────────────────────────────────────────────────── */}
      <Dialog
        open={rescheduleOpen}
        onClose={() => {
          setRescheduleOpen(false);
        }}
        title={`Reschedule job #${String(job.jobNumber)}`}
        description="The target date recalculates as the new ready date plus 5 business days."
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setRescheduleOpen(false);
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void doReschedule()}
              disabled={!newReadyDate || rescheduleJob.isPending}
              className="w-full sm:w-auto"
            >
              Update ready date
            </Button>
          </>
        }
      >
        <div className="py-2">
          <Field id="reschedule-date" label="New ready date" required>
            {(aria) => (
              <Input
                {...aria}
                type="date"
                value={newReadyDate}
                onChange={(event) => {
                  setNewReadyDate(event.target.value);
                }}
              />
            )}
          </Field>
          {job.driverId !== null && (
            <Alert variant="warning" title="Already allocated" className="mt-4">
              This job is on {job.driverName}’s run. Moving the date takes it off that day’s run
              sheet, so the driver needs to know.
            </Alert>
          )}
        </div>
      </Dialog>

      {/* ── Cancel ───────────────────────────────────────────────────────── */}
      <Dialog
        open={cancelOpen}
        onClose={() => {
          setCancelOpen(false);
        }}
        title={`Cancel job #${String(job.jobNumber)}?`}
        description="Cancellation is recorded with a structured reason so it becomes reportable."
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCancelOpen(false);
              }}
              className="w-full sm:w-auto"
            >
              Keep job
            </Button>
            <Button
              variant="destructive"
              onClick={() => void doCancel()}
              disabled={cancelJob.isPending}
              className="w-full sm:w-auto"
            >
              Cancel job
            </Button>
          </>
        }
      >
        <div className="space-y-4 py-2">
          <Field id="cancel-reason" label="Reason" required hint="Reason codes, never free text.">
            {(aria) => (
              <Select
                {...aria}
                value={cancelReason}
                onChange={(event) => {
                  setCancelReason(event.target.value as ExceptionReason);
                }}
              >
                {EXCEPTION_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {EXCEPTION_REASON_LABELS[reason]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field id="cancel-note" label="Note">
            {(aria) => (
              <Textarea
                {...aria}
                rows={2}
                value={cancelNote}
                onChange={(event) => {
                  setCancelNote(event.target.value);
                }}
                placeholder="Anything the customer said, for the record."
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
