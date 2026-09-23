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
import {
  CheckCircle2Icon,
  FileTextIcon,
  MaximizeIcon,
  MinimizeIcon,
  PaperclipIcon,
  XIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';

import { useAccountOptions } from '@/features/lookups/queries';
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
function SourceDocument({
  extraction,
  wide,
  onToggleWide,
}: {
  extraction: PoExtraction;
  wide: boolean;
  onToggleWide: () => void;
}): React.JSX.Element {
  const [showText, setShowText] = useState(false);

  /*
   * ── Why the viewer is sized against the VIEWPORT ──────────────────────────
   * It was a fixed 32rem in a half-width column, which on a laptop renders an
   * A4 page about 380px wide — small enough that a lot number in eight-point
   * type is genuinely unreadable, which is the one thing this pane exists for.
   * The reviewer's only recourse was "Open full size", i.e. leaving the screen
   * that holds the form they are filling in.
   *
   * Capped so it cannot outgrow a tall monitor and leave the toggle offscreen.
   */
  const viewerHeight = wide
    ? 'h-[min(calc(100vh-13rem),64rem)]'
    : 'h-[min(calc(100vh-17rem),48rem)]';

  const url = extraction.documentUrl;

  /**
   * The browser's PDF viewer, with its own furniture turned off.
   *
   * ── Why ───────────────────────────────────────────────────────────────────
   * Chrome renders an embedded PDF with a thumbnail rail down the left and a
   * toolbar across the top — page number, zoom, rotate, and its own summarise
   * button. In a full window that is helpful. In this pane it consumes about a
   * third of the width, so the page the reviewer came to read is squeezed into
   * what is left and every figure needs zooming in to check. The reviewer is
   * comparing two things side by side; the viewer's controls are not one of
   * them.
   *
   * `navpanes=0` drops the thumbnail rail, `toolbar=0` the strip above it, and
   * `view=FitH` makes the page fill the width it just got back. The buttons
   * that matter — widen, and open in a real window — are ours, above.
   *
   * ⚠️ A FRAGMENT, not a query parameter. The URL is presigned, and anything
   * added to its query string changes the signature and returns a 403. A
   * fragment never leaves the browser, so S3 never sees it.
   *
   * Support is the browser's to give: Firefox ignores these and shows its own
   * viewer, which is a cosmetic difference, not a broken pane.
   */
  const embedUrl = url === null ? null : `${url}#toolbar=0&navpanes=0&view=FitH`;

  /*
   * Images are stored alongside PDFs — a supervisor photographs an order as
   * often as the office is emailed one. The stored type is not in the response,
   * but the attachment's own name is, and that is what it was saved under.
   */
  const isImage = /\.(jpe?g|png|heic|heif|webp)$/i.test(extraction.attachmentName);

  const textPane = (
    <pre className="max-h-[min(calc(100vh-17rem),48rem)] overflow-auto rounded-md bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
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

        <div className="flex items-center gap-1">
          {/*
            Widening drops the form below the document rather than beside it.
            Checking a figure and typing a correction are separate moments, and
            the half-width column was sized for neither.
          */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleWide}
            aria-pressed={wide}
            className="hidden lg:inline-flex"
          >
            {wide ? (
              <>
                <MinimizeIcon aria-hidden className="size-4" />
                Side by side
              </>
            ) : (
              <>
                <MaximizeIcon aria-hidden className="size-4" />
                Widen
              </>
            )}
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
            className="focus-ring rounded px-2 text-xs text-muted-foreground underline underline-offset-4"
          >
            Open full size ↗
          </a>
        </div>
      </div>

      {showText ? (
        textPane
      ) : isImage ? (
        <img
          src={url}
          alt={`Purchase order ${extraction.attachmentName}`}
          className={`${viewerHeight} w-full rounded-md border border-border bg-muted object-contain`}
        />
      ) : (
        <object
          data={embedUrl ?? url}
          type="application/pdf"
          aria-label={`Purchase order ${extraction.attachmentName}`}
          className={`${viewerHeight} w-full rounded-md border border-border bg-muted`}
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
  const accounts = useAccountOptions();

  const [poNumber, setPoNumber] = useState(extraction.poNumber ?? '');
  const [accountId, setAccountId] = useState(extraction.suggestedAccountId ?? '');
  const [jobId, setJobId] = useState(extraction.suggestedJobId ?? '');

  /*
   * ── The spec, as typed by the reviewer ─────────────────────────────────
   * These used to be read-only. The confirm sent `extraction.extractedAreaM2`
   * and friends straight through, so a reviewer could see the document said 400
   * m² while the screen said 707, and had no way to fix it — the wrong figure
   * became a purchase order, and the job was priced on it. `suburb` was worse:
   * hard-coded `null`, so the zone that sets the price was never carried at all.
   *
   * They also make the correction rate real. `whatChanged()` compares these
   * against what was extracted, and with nothing editable it could only ever
   * report "no corrections" — which is now the only accuracy signal there is,
   * the confidence scores having gone.
   */
  const [areaM2, setAreaM2] = useState(
    extraction.extractedAreaM2 === null ? '' : String(extraction.extractedAreaM2),
  );
  const [bagAllowance, setBagAllowance] = useState(
    extraction.extractedBagAllowance === null ? '' : String(extraction.extractedBagAllowance),
  );
  const [lotNumber, setLotNumber] = useState(extraction.extractedLotNumber ?? '');
  const [addressLine, setAddressLine] = useState(extraction.extractedSiteAddress ?? '');
  const [suburb, setSuburb] = useState('');
  const [supervisorName, setSupervisorName] = useState(
    extraction.extractedSupervisorName ?? '',
  );
  const [supervisorMobile, setSupervisorMobile] = useState(
    extraction.extractedSupervisorMobile ?? '',
  );
  const [amount, setAmount] = useState(extraction.amountExGst ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);

  /*
   * Which of the two panes gets the room. Not persisted: the choice belongs to
   * the document in front of you — a dense four-page order wants the width, the
   * one-page order after it does not.
   */
  const [wide, setWide] = useState(false);

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
     * Checked here so the reviewer is told at the field rather than by a toast.
     * The API enforces all of it again — see `PoConfirmationSchema`.
     */
    if (areaM2.trim() !== '' && !(Number(areaM2) >= 0 && Number(areaM2) <= 100_000)) {
      next.areaM2 = 'Enter the square metres as a plain number, or leave it blank.';
    }
    if (bagAllowance.trim() !== '' && !Number.isInteger(Number(bagAllowance))) {
      next.bagAllowance = 'Whole bags only, or leave it blank.';
    }
    if (amount.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
      next.amount =
        'Enter the value as it appears, like "1250.00". A purchase order cannot be negative.';
    }
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
          // The spec as the reviewer left it. Sent back even where unchanged:
          // the correction rate is the accuracy metric, and it needs the values
          // that were accepted as well as the ones that were fixed.
          expectedAreaM2: areaM2.trim() === '' ? null : Number(areaM2),
          bagAllowance: bagAllowance.trim() === '' ? null : Number(bagAllowance),
          lotNumber: lotNumber.trim() || null,
          addressLine: addressLine.trim() || null,
          suburb: suburb.trim() || null,
          siteSupervisorName: supervisorName.trim() || null,
          siteSupervisorMobile: supervisorMobile.trim() || null,
          amountExGst: amount.trim() || null,
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

      {!decided && (
        <Alert variant="info" title="Check every figure against the document">
          Nothing here is confirmed until you say so. Read the order beside these fields and
          correct anything that does not match — what you change is what gets saved.
        </Alert>
      )}

      {/*
        Side-by-side above `lg`, stacked below. `items-start` so the two cards do
        not stretch to a shared height — the document is long and the form is not.
      */}
      {/*
        3:2, not 1:1. The two panes are not equal work: one is an A4 page that
        has to be legible, the other is a column of short inputs that was
        already comfortable at half width and is more comfortable narrower. An
        even split was sized for the form.
      */}
      <div
        className={`grid grid-cols-1 items-start gap-6 ${wide ? '' : 'lg:grid-cols-[3fr_2fr]'}`}
      >
        {/*
          Sticky above `lg`, so the document stays put while the reviewer works
          down the form. Without it the page scrolls as one: by the time you
          reach the order value, the figure you are checking it against has gone
          off the top of the screen — and checking against memory is exactly the
          failure this screen exists to prevent.
        */}
        <Card className={wide ? undefined : 'lg:sticky lg:top-6'}>
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
            <SourceDocument
              extraction={extraction}
              wide={wide}
              onToggleWide={() => setWide(!wide)}
            />
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/*
            ── The figures, editable ─────────────────────────────────────────
            This was a read-only list with a confidence percentage beside each
            row. Both halves were wrong. The percentage reported the model’s
            opinion of itself, which invited confirming a high-scoring order
            without opening the document; and being read-only meant a reviewer
            who DID open it, and saw the area was wrong, could do nothing about
            it. The wrong figure became a purchase order, and the job was priced
            on it.

            So the values are inputs, pre-filled with what was read. Blank is a
            real answer everywhere here — Matt, 31:04, on the Wisdom orders:
            *"we’re on a fixed price with them. So they don’t actually give us
            square metres."* Forcing a number would invent one.
          */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What was read from it</CardTitle>
              <p className="text-xs text-muted-foreground">
                Pre-filled from the document. Correct anything that does not match it.
              </p>
            </CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                id="po-area"
                label="Plasterboard area (m²)"
                error={errors.areaM2}
                hint="Blank where the order is a fixed price and carries no area."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={areaM2}
                    disabled={decided}
                    inputMode="decimal"
                    onChange={(event) => {
                      setAreaM2(event.target.value);
                      setErrors(({ areaM2: _drop, ...rest }) => rest);
                    }}
                  />
                )}
              </Field>

              <Field id="po-bags" label="Bag allowance" error={errors.bagAllowance}>
                {(control) => (
                  <Input
                    {...control}
                    value={bagAllowance}
                    disabled={decided}
                    inputMode="numeric"
                    onChange={(event) => {
                      setBagAllowance(event.target.value);
                      setErrors(({ bagAllowance: _drop, ...rest }) => rest);
                    }}
                  />
                )}
              </Field>

              <Field id="po-lot" label="Lot number">
                {(control) => (
                  <Input
                    {...control}
                    value={lotNumber}
                    disabled={decided}
                    onChange={(event) => {
                      setLotNumber(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field
                id="po-suburb"
                label="Suburb"
                hint="Sets the zone, and the zone is the price."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={suburb}
                    disabled={decided}
                    placeholder="Medowie"
                    onChange={(event) => {
                      setSuburb(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field id="po-address" label="Site address" className="sm:col-span-2">
                {(control) => (
                  <Input
                    {...control}
                    value={addressLine}
                    disabled={decided}
                    onChange={(event) => {
                      setAddressLine(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field id="po-supervisor" label="Site supervisor">
                {(control) => (
                  <Input
                    {...control}
                    value={supervisorName}
                    disabled={decided}
                    onChange={(event) => {
                      setSupervisorName(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field
                id="po-supervisor-mobile"
                label="Supervisor mobile"
                hint="They are given a portal login from this number."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={supervisorMobile}
                    disabled={decided}
                    type="tel"
                    inputMode="tel"
                    onChange={(event) => {
                      setSupervisorMobile(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field
                id="po-amount"
                label="Order value (ex GST)"
                error={errors.amount}
                className="sm:col-span-2"
              >
                {(control) => (
                  <Input
                    {...control}
                    value={amount}
                    disabled={decided}
                    inputMode="decimal"
                    className="font-mono"
                    placeholder="1250.00"
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setErrors(({ amount: _drop, ...rest }) => rest);
                    }}
                  />
                )}
              </Field>
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
                hint="Best matches first. Any account can be chosen — the sender is often new."
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
                    {/*
                      Best matches first, then EVERY other account.

                      ⚠️ This list used to be the candidates alone. When the
                      extractor matched nothing — which is `no-account-match`, one
                      of the reasons that puts an order in this queue in the first
                      place — the list held only the placeholder, and the field is
                      required. The reviewer could not confirm the order at all.
                      Their only way out was Reject, which files a genuine purchase
                      order as "not a purchase order" because it came from an
                      address nobody had seen before.
                    */}
                    {extraction.accountCandidates.length > 0 && (
                      <optgroup label="Best match">
                        {extraction.accountCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.label} — {candidate.detail}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="All accounts">
                      {(accounts.data ?? [])
                        .filter(
                          (option) =>
                            !extraction.accountCandidates.some(
                              (candidate) => candidate.id === option.value,
                            ),
                        )
                        .map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                    </optgroup>
                  </Select>
                )}
              </Field>

              {/*
                NOT required, and it used to say it was.

                The validation above deliberately does not check this field, and
                explains why: a builder’s order lands three to four months before
                the work, so there is usually no job to attach it to yet. The
                control still rendered a red asterisk and “(required)”, which is
                the exact pressure that comment warns about — a reviewer picking
                a wrong job to get past the form. The label now matches the rule.
              */}
              <Field
                id="po-review-job"
                label="Job"
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
