import { INVOICE_KIND_LABELS, XERO_SYNC_LABELS } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { FileTextIcon, RefreshCwIcon, SendIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { InvoiceStatusBadge } from '@/components/domain-badges';
import { PageHeader } from '@/components/page-header';
import {
  useInvoice,
  useRecordPo,
  useRequestInvoicePdf,
  useRetryXero,
  useSendInvoices,
} from '@/features/invoices/queries';
import { useSettings } from '@/features/settings/queries';
import { describeError } from '@/lib/error-message';
import {
  formatDate,
  formatDateTime,
  formatInvoiceNumber,
  formatMoney,
  formatRelative,
} from '@/lib/format';

/**
 * One invoice (M7).
 *
 * ── The line table is a functional gain, not parity ────────────────────────
 * It renders **quantity × rate = amount**, which TransVirtual cannot do. Matt:
 * *"in a perfect world I'd have 2 residential recycling bags at $30 each,
 * equalling $60, and then the weight charge at a rate of 16 cents per square
 * metre."* Worth demoing, so it is the most prominent thing on the page.
 *
 * ── Xero is shown honestly ─────────────────────────────────────────────────
 * Including when it has failed or reported nothing. Their current invoice list
 * shows payment status "Unknown" for several customers because the sync only
 * partly works — hiding that would hide the thing worth fixing.
 */
export function AdminInvoiceDetailPage() {
  const { invoiceId } = useParams();
  const toast = useToast();

  const { data: invoice, error, isPending, refetch } = useInvoice(invoiceId);
  const prefix = useSettings().data?.invoicing.invoiceNumberPrefix ?? '';
  const sendInvoices = useSendInvoices();
  const recordPo = useRecordPo();
  const retryXero = useRetryXero();
  const requestPdf = useRequestInvoicePdf();

  const [poOpen, setPoOpen] = useState(false);
  const [poNumber, setPoNumber] = useState('');
  const [poError, setPoError] = useState<string | null>(null);

  const breadcrumbs = [{ label: 'Invoices', to: '/admin/invoices' }];

  if (error) {
    const described = describeError(error);
    return (
      <div className="space-y-6">
        <PageHeader title="Invoice" breadcrumbs={breadcrumbs} />
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

  if (isPending || !invoice) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading…" breadcrumbs={breadcrumbs} />
        <Card className="p-5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
    );
  }

  const send = async () => {
    try {
      await sendInvoices.mutateAsync([invoice.id]);
      toast.success(
        `Invoice ${formatInvoiceNumber(invoice.invoiceNumber, prefix)} sent`,
        'Pushed to Xero and emailed.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const savePo = async () => {
    setPoError(null);
    try {
      await recordPo.mutateAsync({ id: invoice.id, poNumber });
      toast.success('Purchase order recorded', 'These charges can now be approved and sent.');
      setPoOpen(false);
      setPoNumber('');
    } catch (caught) {
      const described = describeError(caught);
      setPoError(described.detail ?? described.title);
    }
  };

  const retry = async () => {
    try {
      await retryXero.mutateAsync(invoice.id);
      toast.success('Re-sent to Xero');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const pdf = async () => {
    try {
      await requestPdf.mutateAsync([invoice.id]);
      toast.success('PDF queued', 'Rendered server-side from the invoice template.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Invoice ${formatInvoiceNumber(invoice.invoiceNumber, prefix)}`}
        breadcrumbs={breadcrumbs}
        description={`${invoice.accountName} · ${INVOICE_KIND_LABELS[invoice.kind]}`}
        badge={<InvoiceStatusBadge status={invoice.status} />}
        actions={
          <>
            <Button variant="outline" onClick={() => void pdf()} disabled={requestPdf.isPending}>
              <FileTextIcon aria-hidden />
              PDF
            </Button>
            {invoice.status === 'awaiting-po' ? (
              <Button
                onClick={() => {
                  setPoNumber(invoice.poNumber ?? '');
                  setPoOpen(true);
                }}
              >
                Record PO
              </Button>
            ) : invoice.status === 'draft' ? (
              <Button onClick={() => void send()} disabled={sendInvoices.isPending}>
                {sendInvoices.isPending && <Spinner className="text-current" />}
                <SendIcon aria-hidden />
                Send invoice
              </Button>
            ) : null}
          </>
        }
      />

      {invoice.status === 'awaiting-po' && (
        <Alert variant="warning" title="Held until a purchase order arrives">
          These charges were approved but this account requires a PO before invoicing. The base
          invoice for the job went out on completion and is not affected.
        </Alert>
      )}

      {invoice.xeroState === 'failed' && (
        <Alert variant="destructive" title="Xero rejected this invoice">
          <p>{invoice.xeroMessage}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void retry()}
            disabled={retryXero.isPending}
          >
            <RefreshCwIcon aria-hidden />
            Retry Xero push
          </Button>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Lines ──────────────────────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Lines</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Lines on invoice {invoice.invoiceNumber}</caption>
                <thead>
                  <tr className="border-b border-border">
                    <th
                      scope="col"
                      className="py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                    >
                      Description
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
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line) => (
                    <tr key={line.id} className="border-b border-border">
                      <td className="py-2.5">
                        <span className="block">{line.description}</span>
                        {line.raisedBy && (
                          <span className="block text-xs text-muted-foreground">
                            Raised by {line.raisedBy}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {line.quantity.toLocaleString('en-AU')}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {formatMoney(line.unitRate)}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums">
                        {formatMoney(line.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="py-2 text-right text-muted-foreground">
                      Subtotal ex GST
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(invoice.subtotalExGst)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} className="py-2 text-right text-muted-foreground">
                      GST
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(invoice.gst)}</td>
                  </tr>
                  <tr className="border-t border-border">
                    <td colSpan={3} className="py-2.5 text-right font-medium">
                      Total inc GST
                    </td>
                    <td className="py-2.5 text-right font-display text-lg font-semibold tabular-nums">
                      {formatMoney(invoice.totalIncGst)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Quantity × rate = amount, on every line. TransVirtual cannot render quantities — this
              is a functional gain, not parity.
            </p>
          </CardContent>
        </Card>

        {/* ── Meta ───────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={1}
                items={[
                  {
                    label: 'Customer',
                    value: (
                      <Link
                        to={`/admin/customers/${invoice.accountId}`}
                        className="focus-ring rounded text-primary underline-offset-4 hover:underline"
                      >
                        {invoice.accountName}
                      </Link>
                    ),
                  },
                  {
                    label: 'Job',
                    value: invoice.jobId ? (
                      <Link
                        to={`/admin/jobs/${invoice.jobId}`}
                        className="focus-ring rounded font-mono text-primary underline-offset-4 hover:underline"
                      >
                        #{invoice.jobNumber}
                      </Link>
                    ) : (
                      '—'
                    ),
                  },
                  { label: 'Purchase order', value: invoice.poNumber ?? 'Not supplied' },
                  { label: 'Customer reference', value: invoice.poNumber ?? '—' },
                  { label: 'Issued', value: formatDate(invoice.issuedOn) },
                  {
                    label: 'Due',
                    value: `${formatDate(invoice.dueOn)} · ${String(invoice.paymentTermsDays)}-day terms`,
                  },
                  { label: 'Template', value: invoice.templateName },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payment and Xero</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <DetailList
                columns={1}
                items={[
                  {
                    label: 'Payment status',
                    value: <InvoiceStatusBadge status={invoice.status} />,
                  },
                  {
                    label: 'Paid',
                    value: invoice.paidAt === null ? 'Not yet' : formatDateTime(invoice.paidAt),
                  },
                  {
                    label: 'Xero',
                    value: (
                      <Badge
                        variant={
                          invoice.xeroState === 'synced'
                            ? 'success'
                            : invoice.xeroState === 'failed'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {XERO_SYNC_LABELS[invoice.xeroState]}
                      </Badge>
                    ),
                  },
                  { label: 'Last sync', value: formatRelative(invoice.xeroLastSyncAt) },
                ]}
              />

              {invoice.xeroState === 'unknown' && (
                <Alert variant="warning" title="Xero has not reported a status">
                  This is the gap the 2-way sync closes. Credit notes, part-payments and bank
                  reconciliation are out of scope for v1.
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Record PO ───────────────────────────────────────────────────── */}
      <Dialog
        open={poOpen}
        onClose={() => {
          setPoOpen(false);
        }}
        title="Record the purchase order"
        description="Once the PO is recorded these charges can be approved and sent. The job's base invoice is unaffected."
        footer={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setPoOpen(false);
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void savePo()}
              disabled={recordPo.isPending}
              className="w-full sm:w-auto"
            >
              {recordPo.isPending && <Spinner className="text-current" />}
              Save PO
            </Button>
          </>
        }
      >
        <div className="py-2">
          <Field
            id="invoice-po"
            label="Purchase order number"
            required
            error={poError ?? undefined}
            hint="As issued by the customer, e.g. 29916613/096."
          >
            {(aria) => (
              <Input
                {...aria}
                value={poNumber}
                onChange={(event) => {
                  setPoNumber(event.target.value);
                }}
                autoComplete="off"
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
