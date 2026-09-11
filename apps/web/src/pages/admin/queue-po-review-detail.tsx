import {
  PO_REVIEW_REASON_LABELS,
  PO_REVIEW_STATE_LABELS,
  type PoExtraction,
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
  ErrorState,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { CheckCircle2Icon, FileTextIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { bandOf, percent } from '@/components/queues/confidence-bands';
import { ConfidenceBadge } from '@/components/queues/confidence';
import { usePoExtraction, usePoReviewConfirm, usePoReviewReject } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatDateTime, formatMoney } from '@/lib/format';

/**
 * The original, beside the figures that were read off it.
 *
 * ── Why the page and not just the OCR text ────────────────────────────────
 * Matt, 28:30: *"I'd be looking at a copy of the PDF too."* The extracted text
 * proves what the model saw; it does not let a reviewer check a lot number
 * against the box it was printed in, or notice that the supervisor's mobile is
 * in eight-point type at the foot of page two. Confirming eight values against
 * nothing is not a review, and it is the step Matt agreed to do on every order.
 *
 * ── Why the text stays ────────────────────────────────────────────────────
 * A poor scan is exactly when the OCR text is most useful — it shows what the
 * model actually managed to read, which is what explains a bad extraction. So
 * it moves behind a toggle rather than being replaced.
 *
 * ── Why an `<object>` and not an `<iframe>` ──────────────────────────────
 * It degrades. A browser with no inline PDF viewer renders the children instead
 * of an empty grey box, so the reviewer gets a link rather than something that
 * looks broken.
 */
function SourceDocument({ extraction }: { extraction: PoExtraction }): React.JSX.Element {
  const [showText, setShowText] = useState(false);

  const url = extraction.documentUrl;

  /*
   * Images are stored alongside PDFs — a supervisor photographs an order as
   * often as the office is emailed one. The stored type is not in the response,
   * but the attachment's own name is, and that is what it was saved under.
   */
  const isImage = /\.(jpe?g|png|heic|heif|webp)$/i.test(extraction.attachmentName);

  const textPane = (
    <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {extraction.documentText.trim() === ''
        ? 'The extractor returned no text for this document.'
        : extraction.documentText}
    </pre>
  );

  /*
   * No stored copy. Honest about why, rather than an empty embed that reads as
   * a broken page — see the warning on `documentUrl`.
   */
  if (url === null) {
    return (
      <>
        {textPane}
        <p className="mt-2 text-xs text-muted-foreground">
          Only the extracted text is available — the original could not be copied into storage when
          this order arrived. Check the source email if a figure looks wrong.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowText(!showText)}>
          {showText ? 'Show the document' : 'Show the extracted text'}
        </Button>
        {/*
          A single-window embed is no way to read a four-page order. The link
          hands it to the browser's own viewer, where it can be zoomed, searched
          and printed.
        */}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="focus-ring rounded text-xs text-muted-foreground underline underline-offset-4"
        >
          Open full size ↗
        </a>
      </div>

      {showText ? (
        textPane
      ) : isImage ? (
        <img
          src={url}
          alt={`Purchase order ${extraction.attachmentName}`}
          className="max-h-[32rem] w-full rounded-md border border-border bg-muted object-contain"
        />
      ) : (
        <object
          data={url}
          type="application/pdf"
          aria-label={`Purchase order ${extraction.attachmentName}`}
          className="h-[32rem] w-full rounded-md border border-border bg-muted"
        >
          <div className="p-4 text-sm">
            <p className="mb-2">This browser will not display the PDF inline.</p>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded underline underline-offset-4"
            >
              Open {extraction.attachmentName}
            </a>
          </div>
        </object>
      )}
    </>
  );
}

/**
 * One emailed purchase order, reviewed (M2.12).
 *
 * ── The layout is the requirement ─────────────────────────────────────────
 * M2.12 asks for the *"source document shown side-by-side with the extracted
 * fields"*, and that is not decoration: the reviewer's job is to compare two
 * things, and any layout that makes them scroll between the two turns a
 * ten-second confirmation into a minute of context-switching. Two columns above
 * `lg`, stacked below — document first, because you read before you correct.
 *
 * ── Correcting is the point, not an escape hatch ──────────────────────────
 * Every extracted field is editable and every match is a dropdown of real
 * records. "Extract, then *match*" — resolve to actual Account and Job rows
 * rather than trusting free text — is one of the design rules, and the
 * correction is the training signal the accuracy metric is built from. So the
 * confirm sends the corrected values, not just the ids.
 */
export function AdminQueuePoReviewDetailPage() {
  const { extractionId } = useParams<{ extractionId: string }>();
  const { data: extraction, isPending, error, refetch } = usePoExtraction(extractionId);

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error !== null && error !== undefined) {
    const described = describeError(error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        onRetry={described.retryable ? () => void refetch() : undefined}
      />
    );
  }

  if (!extraction) return null;

  return <PoReviewDetail extraction={extraction} />;
}

function PoReviewDetail({ extraction }: { extraction: PoExtraction }) {
  const toast = useToast();
  const navigate = useNavigate();
  const confirm = usePoReviewConfirm();
  const reject = usePoReviewReject();

  const [poNumber, setPoNumber] = useState(extraction.poNumber ?? '');
  const [accountId, setAccountId] = useState(extraction.suggestedAccountId ?? '');
  const [jobId, setJobId] = useState(extraction.suggestedJobId ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  const decided = extraction.state !== 'needs-review';
  const busy = confirm.isPending || reject.isPending;

  const submit = async () => {
    const next: Record<string, string> = {};
    if (!poNumber.trim()) {
      next.poNumber = 'Read the PO number off the document — the invoice is matched on it.';
    } else if (poNumber.trim().length > 60) {
      next.poNumber = 'That is longer than any PO number we have seen. Check for a pasted line.';
    }
    if (!accountId) next.accountId = 'Choose the account this purchase order belongs to.';
    /*
     * The job is optional, deliberately.
     *
     * A builder's order lands three to four months before the work (Matt,
     * 28:40), so there is usually no job to attach it to yet — the call-up email
     * a week out is what creates one. Requiring a job here would make the
     * reviewer pick a wrong one to get past the form.
     */

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      await confirm.mutateAsync({
        id: extraction.id,
        input: {
          poNumber: poNumber.trim(),
          accountId,
          jobId: jobId || null,
          // The spec as extracted. Sent back even unchanged: the correction rate
          // is the accuracy metric, and it needs the accepted values too.
          expectedAreaM2: extraction.extractedAreaM2,
          bagAllowance: extraction.extractedBagAllowance,
          lotNumber: extraction.extractedLotNumber,
          addressLine: extraction.extractedSiteAddress,
          suburb: null,
          siteSupervisorName: extraction.extractedSupervisorName,
          siteSupervisorMobile: extraction.extractedSupervisorMobile,
          amountExGst: extraction.amountExGst,
        },
      });
      toast.success(
        `PO ${poNumber.trim()} confirmed`,
        jobId
          ? 'Anything that was waiting on this purchase order has been released.'
          : 'Held against the account. The call-up email will turn it into a job.',
      );
      await navigate('/admin/queues/po-review');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submitRejection = async () => {
    if (rejectNote.trim().length < 5) {
      setRejectError('Say what this document actually is, so the pipeline can be tuned for it.');
      return;
    }

    try {
      await reject.mutateAsync({ id: extraction.id, note: rejectNote.trim() });
      toast.success('Marked as not a purchase order', 'It stays on file against the sender.');
      setRejecting(false);
      await navigate('/admin/queues/po-review');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const shakyFields = extraction.fields.filter((field) => bandOf(field.confidence) !== 'high');

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Queues' }, { label: 'PO review', to: '/admin/queues/po-review' }]}
        title={extraction.poNumber ? `PO ${extraction.poNumber}` : 'Unreadable PO number'}
        description={
          <>
            From <span className="font-medium">{extraction.fromAddress}</span> ·{' '}
            {formatDateTime(extraction.receivedAt)}
          </>
        }
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant={decided ? 'success' : 'warning'}>
              {PO_REVIEW_STATE_LABELS[extraction.state]}
            </Badge>
            <Badge variant="outline">{PO_REVIEW_REASON_LABELS[extraction.reason]}</Badge>
            <ConfidenceBadge confidence={extraction.overallConfidence} />
            {!decided && <AgeBadge since={extraction.receivedAt} warnDays={2} alarmDays={5} />}
          </span>
        }
        actions={
          decided ? undefined : (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setRejecting(true);
                }}
              >
                <XIcon aria-hidden />
                Not a PO
              </Button>
              <Button disabled={busy} onClick={() => void submit()}>
                {confirm.isPending && <Spinner label="Attaching" />}
                <CheckCircle2Icon aria-hidden />
                Confirm and attach
              </Button>
            </>
          )
        }
      />

      {decided && (
        <Alert
          variant={extraction.state === 'confirmed' ? 'success' : 'info'}
          title={`Already ${PO_REVIEW_STATE_LABELS[extraction.state].toLowerCase()}`}
        >
          {extraction.reviewedBy} reviewed this on {formatDateTime(extraction.reviewedAt)}.
        </Alert>
      )}

      {!decided && shakyFields.length > 0 && (
        <Alert
          variant="warning"
          title={`${shakyFields.length} field${shakyFields.length === 1 ? '' : 's'} worth checking`}
        >
          {shakyFields.map((field) => field.label).join(', ')} came back below 85% confidence. The
          rest matched cleanly — check these against the document and correct them in place.
        </Alert>
      )}

      {/*
        Side-by-side above `lg`, stacked below. `items-start` so the two cards do
        not stretch to a shared height — the document is long and the form is not.
      */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileTextIcon aria-hidden className="size-4 text-muted-foreground" />
              Source document
            </CardTitle>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <PaperclipIcon aria-hidden className="size-3" />
              <span className="font-mono">{extraction.attachmentName}</span>
              <span>
                · {extraction.pageCount} page{extraction.pageCount === 1 ? '' : 's'}
              </span>
            </p>
          </CardHeader>
          <CardContent>
            <SourceDocument extraction={extraction} />
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What was read from it</CardTitle>
              <p className="text-xs text-muted-foreground">
                Per-field confidence, so you check two fields instead of re-reading eight.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y divide-border">
                {extraction.fields.map((field) => {
                  const band = bandOf(field.confidence);
                  return (
                    <li
                      key={field.key}
                      className="flex flex-wrap items-center justify-between gap-2 px-6 py-2.5"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{field.label}</span>
                        <span className="block truncate text-sm font-medium">
                          {field.value ?? <span className="text-destructive">not legible</span>}
                        </span>
                      </span>
                      <span
                        className={
                          band === 'high'
                            ? 'text-xs text-muted-foreground tabular-nums'
                            : band === 'medium'
                              ? 'text-xs font-medium text-warning tabular-nums'
                              : 'text-xs font-medium text-destructive tabular-nums'
                        }
                      >
                        {percent(field.confidence)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Attach it</CardTitle>
              <p className="text-xs text-muted-foreground">
                Resolved to real records, never free text — an unmatchable PO stays a queue item.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <Field
                id="po-review-number"
                label="PO number"
                required
                error={errors.poNumber}
                hint="Exactly as issued. Builders' AP systems match character for character."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={poNumber}
                    disabled={decided}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => {
                      setPoNumber(event.target.value);
                      setErrors(({ poNumber: _drop, ...rest }) => rest);
                    }}
                  />
                )}
              </Field>

              <Field
                id="po-review-account"
                label="Account"
                required
                error={errors.accountId}
                hint="Ranked by how well the sender and the document matched."
              >
                {(control) => (
                  <Select
                    {...control}
                    value={accountId}
                    disabled={decided}
                    onChange={(event) => {
                      setAccountId(event.target.value);
                      setErrors(({ accountId: _drop, ...rest }) => rest);
                    }}
                  >
                    <option value="">Choose an account…</option>
                    {extraction.accountCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label} — {candidate.detail} ({percent(candidate.confidence)})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field
                id="po-review-job"
                label="Job"
                required
                error={errors.jobId}
                hint="Open jobs on that account. Attaching releases anything waiting on this PO."
              >
                {(control) => (
                  <Select
                    {...control}
                    value={jobId}
                    disabled={decided || extraction.jobCandidates.length === 0}
                    onChange={(event) => {
                      setJobId(event.target.value);
                      setErrors(({ jobId: _drop, ...rest }) => rest);
                    }}
                  >
                    <option value="">Choose a job…</option>
                    {extraction.jobCandidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label} — {candidate.detail}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              {extraction.jobCandidates.length === 0 && (
                <Alert variant="warning" title="No candidate jobs on this account">
                  Nothing on this account is waiting for a purchase order. Either the PO is for work
                  not yet booked, or it belongs to a different account — check the sender before
                  attaching.
                </Alert>
              )}

              <DetailList
                columns={2}
                items={[
                  { label: 'Amount on document', value: formatMoney(extraction.amountExGst) },
                  {
                    label: 'Overall confidence',
                    value: <ConfidenceBadge confidence={extraction.overallConfidence} />,
                  },
                ]}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={rejecting}
        onClose={() => {
          setRejecting(false);
          setRejectError(null);
        }}
        title="Not a purchase order?"
        description="It stays on file against the sender, and the pipeline learns this layout is not a PO."
        footer={
          <>
            <Button
              variant="ghost"
              disabled={reject.isPending}
              onClick={() => {
                setRejecting(false);
                setRejectError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reject.isPending}
              onClick={() => void submitRejection()}
            >
              {reject.isPending && <Spinner label="Saving" />}
              Mark as not a PO
            </Button>
          </>
        }
      >
        <Field
          id="po-reject-note"
          label="What is it instead?"
          required
          hint="A remittance advice, a quote request, a duplicate — the specific answer is what makes the extraction rules improvable."
          error={rejectError ?? undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={500}
              value={rejectNote}
              placeholder="Remittance advice, not a PO — lists three invoices already paid."
              onChange={(event) => {
                setRejectNote(event.target.value);
                setRejectError(null);
              }}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}
