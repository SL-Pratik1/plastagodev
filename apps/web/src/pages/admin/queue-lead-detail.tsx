import {
  BRAND_LABELS,
  CAPTURE_MODES,
  CAPTURE_MODE_LABELS,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  PO_POLICIES,
  PO_POLICY_LABELS,
  RATE_CARDS,
  RATE_CARD_LABELS,
  ZONES,
  ZONE_LABELS,
  type BrandId,
  type CaptureMode,
  type Lead,
  type LeadStatus,
  type PoPolicy,
  type RateCardId,
  type Zone,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  ErrorState,
  Field,
  Input,
  Label,
  Select,
  Skeleton,
  Spinner,
  Textarea,
  buttonVariants,
  useToast,
} from '@plastago/ui';
import {
  ArrowRightIcon,
  BuildingIcon,
  FileTextIcon,
  MailIcon,
  PaperclipIcon,
  PhoneIcon,
  SproutIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { CONFIGURED_BRAND_IDS, IS_MULTI_BRAND } from '@/config/brands';
import {
  useLead,
  useLeadAttach,
  useLeadConvert,
  useLeadDetach,
  useLeadUpdate,
} from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDateTime, formatMobile } from '@/lib/format';

/**
 * One lead, and the conversion (M5 · Journey A · A.3 + A.4).
 *
 * ── Why converting is a deliberate, multi-field flow ──────────────────────
 * A.4 is *"one flow: create the account, assign a rate card, set PO policy,
 * capture configuration, payment terms, brand, contacts, first site — then send
 * the invitation."* Every one of those is a commercial commitment. A "Convert"
 * button that guessed the rate card would produce mispriced invoices from the
 * first job, and mispricing is Risk 1. So nothing is defaulted invisibly: the
 * form shows what each choice means, and it will not submit until the pricing
 * decisions are made explicitly.
 */
export function AdminQueueLeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>();
  const { data: lead, isPending, error, refetch } = useLead(leadId);

  if (isPending) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-72" />
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-72 lg:col-span-2" />
          <Skeleton className="h-72" />
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

  if (!lead) return null;

  return <LeadDetail lead={lead} />;
}

function LeadDetail({ lead }: { lead: Lead }) {
  const toast = useToast();
  const update = useLeadUpdate();

  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [owner, setOwner] = useState(lead.ownerName ?? '');
  const [note, setNote] = useState('');
  const [converting, setConverting] = useState(false);

  const converted = lead.convertedAccountId !== null;
  const dirty =
    status !== lead.status || owner !== (lead.ownerName ?? '') || note.trim().length > 0;

  const save = async () => {
    try {
      await update.mutateAsync({ id: lead.id, input: { status, ownerName: owner, note } });
      setNote('');
      toast.success(
        'Lead updated',
        note.trim() ? 'Your note has been added to the thread.' : undefined,
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Queues' }, { label: 'Leads', to: '/admin/queues/leads' }]}
        title={lead.companyName}
        description={
          <>
            {LEAD_SOURCE_LABELS[lead.source]} · enquired {formatDateTime(lead.createdAt)}
          </>
        }
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                lead.status === 'won'
                  ? 'success'
                  : lead.status === 'lost'
                    ? 'outline'
                    : lead.status === 'new'
                      ? 'warning'
                      : 'secondary'
              }
            >
              {LEAD_STATUS_LABELS[lead.status]}
            </Badge>
            {!converted && lead.status !== 'lost' && (
              <AgeBadge since={lead.createdAt} warnDays={2} alarmDays={7} />
            )}
          </span>
        }
        actions={
          converted ? (
            <Link to="/admin/customers" className={buttonVariants({ variant: 'outline' })}>
              <BuildingIcon aria-hidden />
              View accounts
            </Link>
          ) : (
            <Button
              onClick={() => {
                setConverting(true);
              }}
            >
              <ArrowRightIcon aria-hidden />
              Convert to account
            </Button>
          )
        }
      />

      {converted && (
        <Alert variant="success" title="Already converted">
          This lead became an account. Pricing and terms were set during conversion — change them
          on the account, not here.
        </Alert>
      )}

      {lead.zone === null && !converted && (
        <Alert variant="warning" title="Outside the three service zones">
          {lead.suburbs} is not in Sydney, Wollongong or Newcastle. Confirm we can actually service
          it before quoting — an account we cannot reach is worse than a lost lead.
        </Alert>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">What they told us</CardTitle>
              <p className="text-xs text-muted-foreground">
                Straight from the enquiry form — nothing here has been verified yet.
              </p>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={2}
                items={[
                  { label: 'Contact', value: lead.contactName },
                  {
                    label: 'Email',
                    value: (
                      <a
                        href={`mailto:${lead.email}`}
                        className="focus-ring flex items-center gap-1.5 rounded text-primary underline-offset-4 hover:underline"
                      >
                        <MailIcon aria-hidden className="size-3.5 shrink-0" />
                        <span className="truncate">{lead.email}</span>
                      </a>
                    ),
                  },
                  {
                    label: 'Phone',
                    value: lead.mobile ? (
                      <a
                        href={`tel:${lead.mobile}`}
                        className="focus-ring flex items-center gap-1.5 rounded tabular-nums text-primary underline-offset-4 hover:underline"
                      >
                        <PhoneIcon aria-hidden className="size-3.5 shrink-0" />
                        {formatMobile(lead.mobile)}
                      </a>
                    ) : (
                      'Not given'
                    ),
                  },
                  {
                    label: 'Inferred zone',
                    value:
                      lead.zone === null ? (
                        <span className="text-warning">Outside service area</span>
                      ) : (
                        ZONE_LABELS[lead.zone]
                      ),
                  },
                  { label: 'Suburbs', value: lead.suburbs, wide: true },
                  { label: 'Typical volume', value: formatArea(lead.typicalVolumeM2) },
                  { label: 'Expected frequency', value: lead.expectedFrequency },
                  { label: 'How they heard about us', value: lead.heardAbout, wide: true },
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
              <p className="text-xs text-muted-foreground">
                Every status change and note, so a handover does not lose the conversation.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {lead.notes.length === 0 ? (
                <p className="px-6 pb-6 text-sm text-muted-foreground">
                  Nothing logged yet. The enquiry arrived {formatDateTime(lead.createdAt)}.
                </p>
              ) : (
                <ol className="divide-y divide-border">
                  {lead.notes.map((entry) => (
                    <li key={entry.id} className="px-6 py-3">
                      <p className="text-sm">{entry.body}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {entry.author} · {formatDateTime(entry.at)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>

          <LeadAttachments lead={lead} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Progress this lead</CardTitle>
            <p className="text-xs text-muted-foreground">
              Status and owner. A lead with no owner is a lead nobody is chasing.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field id="lead-status" label="Status">
              {(control) => (
                <Select
                  {...control}
                  value={status}
                  disabled={converted}
                  onChange={(event) => {
                    setStatus(event.target.value as LeadStatus);
                  }}
                >
                  {LEAD_STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {LEAD_STATUS_LABELS[option]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              id="lead-owner"
              label="Owner"
              hint="Who is having the conversation. Leave empty to put it back in the pool."
            >
              {(control) => (
                <Input
                  {...control}
                  value={owner}
                  disabled={converted}
                  placeholder="Matthew Browne"
                  onChange={(event) => {
                    setOwner(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id="lead-note"
              label="Add a note"
              hint="What was said, and what happens next. Optional."
            >
              {(control) => (
                <Textarea
                  {...control}
                  rows={4}
                  maxLength={1000}
                  value={note}
                  disabled={converted}
                  placeholder="Spoke to Rachel — 900 m² weekly out of Maitland. Sending Tier 2."
                  onChange={(event) => {
                    setNote(event.target.value);
                  }}
                />
              )}
            </Field>

            <Button
              className="w-full"
              disabled={converted || !dirty || update.isPending}
              onClick={() => void save()}
            >
              {update.isPending && <Spinner label="Saving" />}
              Save changes
            </Button>

            {!converted && status === 'won' && lead.status !== 'won' && (
              <Alert variant="info" title="Marking a lead won does not create the account">
                Use Convert to account — that is where the rate card and terms are set.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <ConvertLeadDialog
        lead={lead}
        open={converting}
        onClose={() => {
          setConverting(false);
        }}
      />
    </div>
  );
}

/* ── A.4 · Convert Lead → Account ─────────────────────────────────────────── */

interface ConvertForm {
  customerCode: string;
  legalName: string;
  abn: string;
  brandId: BrandId;
  rateCardId: RateCardId | '';
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  paymentTermsDays: string;
  primaryZone: Zone;
  sendInvitation: boolean;
}

/**
 * Every field a new account cannot exist without, and nothing else.
 *
 * ── Why the rate card has no default ──────────────────────────────────────
 * Because "default" is itself one of the seven rate cards, and silently choosing
 * it would produce plausible, wrong invoices that nobody queries until the
 * customer does. The select opens empty and the form refuses to submit — a
 * moment's friction against a pricing incident.
 *
 * ── Why validation is hand-rolled here rather than RHF + Zod ──────────────
 * Four of the eleven fields are enum selects with no failure mode, and the three
 * that do validate (code, ABN, terms) each need a message that explains the
 * business rule, not the regex. A resolver would give correct-but-generic
 * messages for exactly the fields where the wording matters most.
 */
function ConvertLeadDialog({
  lead,
  open,
  onClose,
}: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const convert = useLeadConvert();

  const [form, setForm] = useState<ConvertForm>(() => ({
    // Three letters of the company name plus 001 is the pattern their existing
    // codes follow (IPL001, CLA001) — a suggestion, still editable.
    customerCode: `${lead.companyName
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase()}001`,
    legalName: lead.companyName,
    abn: '',
    brandId: 'plastago',
    rateCardId: '',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    paymentTermsDays: '7',
    primaryZone: lead.zone ?? 'sydney',
    sendInvitation: true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = <TKey extends keyof ConvertForm>(key: TKey, value: ConvertForm[TKey]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const { [key]: _dropped, ...rest } = current;
      return rest;
    });
  };

  const submit = async () => {
    const next: Record<string, string> = {};

    if (!/^[A-Z]{3}[0-9]{3}$/.test(form.customerCode)) {
      next.customerCode = 'Three capital letters then three digits, e.g. NEW001.';
    }
    if (!form.legalName.trim()) {
      next.legalName = 'Use the registered company name — this appears on every invoice.';
    }
    const abnDigits = form.abn.replace(/\s/g, '');
    if (!/^\d{11}$/.test(abnDigits)) {
      next.abn = 'An ABN is 11 digits. Check it on ABN Lookup before creating the account.';
    }
    if (!form.rateCardId) {
      next.rateCardId = 'Choose the rate card. Every invoice for this customer is priced from it.';
    }
    const terms = Number(form.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0 || terms > 90) {
      next.paymentTermsDays = 'Whole days, 0 to 90. Their standard is 7.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    try {
      const result = await convert.mutateAsync({
        id: lead.id,
        input: {
          customerCode: form.customerCode,
          legalName: form.legalName.trim(),
          abn: abnDigits,
          brandId: form.brandId,
          rateCardId: form.rateCardId as RateCardId,
          poPolicy: form.poPolicy,
          captureMode: form.captureMode,
          paymentTermsDays: terms,
          primaryZone: form.primaryZone,
          sendInvitation: form.sendInvitation,
        },
      });

      toast.success(
        `${form.legalName.trim()} created as ${result.customerCode}`,
        form.sendInvitation
          ? 'A welcome email with their sign-in link is on its way to the contact.'
          : 'No invitation was sent — you can send one from the account.',
      );
      onClose();
      await navigate('/admin/queues/leads');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Convert ${lead.companyName} to an account`}
      description="Sets the commercial terms this customer will be billed on. Everything here is changeable later on the account, but the first invoice uses what you choose now."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={convert.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={convert.isPending}>
            {convert.isPending && <Spinner label="Creating" />}
            <SproutIcon aria-hidden />
            Create account
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Identity</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="convert-code"
              label="Customer code"
              required
              error={errors.customerCode}
              hint="Quoted on invoices and in their AP system."
            >
              {(control) => (
                <Input
                  {...control}
                  value={form.customerCode}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    set('customerCode', event.target.value.toUpperCase());
                  }}
                />
              )}
            </Field>

            <Field id="convert-abn" label="ABN" required error={errors.abn} hint="11 digits.">
              {(control) => (
                <Input
                  {...control}
                  value={form.abn}
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="24118552901"
                  onChange={(event) => {
                    set('abn', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            id="convert-legal-name"
            label="Registered company name"
            required
            error={errors.legalName}
            hint="As registered — this is what prints on the invoice, not the trading name."
          >
            {(control) => (
              <Input
                {...control}
                value={form.legalName}
                onChange={(event) => {
                  set('legalName', event.target.value);
                }}
              />
            )}
          </Field>

          {/* One configured brand is not a choice, so the form submits its default. */}
          {IS_MULTI_BRAND && (
            <Field id="convert-brand" label="Brand" hint="Which brand services them (M1.1).">
              {(control) => (
                <Select
                  {...control}
                  value={form.brandId}
                  onChange={(event) => {
                    set('brandId', event.target.value as BrandId);
                  }}
                >
                  {CONFIGURED_BRAND_IDS.map((id) => (
                    <option key={id} value={id}>
                      {BRAND_LABELS[id]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </section>

        <section className="space-y-4 rounded-lg border border-border p-4">
          <div>
            <h3 className="text-sm font-semibold">Commercial terms</h3>
            <p className="text-xs text-muted-foreground">
              These decide what this customer is charged. Nothing here is guessed for you.
            </p>
          </div>

          <Field
            id="convert-rate-card"
            label="Rate card"
            required
            error={errors.rateCardId}
            hint="Resolution order is named card → tier → default (M6.1)."
          >
            {(control) => (
              <Select
                {...control}
                value={form.rateCardId}
                onChange={(event) => {
                  set('rateCardId', event.target.value as RateCardId);
                }}
              >
                <option value="">Choose a rate card…</option>
                {RATE_CARDS.map((id) => (
                  <option key={id} value={id}>
                    {RATE_CARD_LABELS[id]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="convert-po-policy"
              label="Purchase order policy"
              hint="Whether an invoice can be sent without a PO."
            >
              {(control) => (
                <Select
                  {...control}
                  value={form.poPolicy}
                  onChange={(event) => {
                    set('poPolicy', event.target.value as PoPolicy);
                  }}
                >
                  {PO_POLICIES.map((policy) => (
                    <option key={policy} value={policy}>
                      {PO_POLICY_LABELS[policy]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              id="convert-capture"
              label="What gets captured"
              hint="m² is priced; kg is recovered weight. Two different quantities."
            >
              {(control) => (
                <Select
                  {...control}
                  value={form.captureMode}
                  onChange={(event) => {
                    set('captureMode', event.target.value as CaptureMode);
                  }}
                >
                  {CAPTURE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {CAPTURE_MODE_LABELS[mode]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              id="convert-terms"
              label="Payment terms (days)"
              required
              error={errors.paymentTermsDays}
              hint="Their standard is 7-day EFT."
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  max={90}
                  value={form.paymentTermsDays}
                  onChange={(event) => {
                    set('paymentTermsDays', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id="convert-zone"
              label="Primary zone"
              hint="Service charge and per-m² rate both vary by zone (M6.3)."
            >
              {(control) => (
                <Select
                  {...control}
                  value={form.primaryZone}
                  onChange={(event) => {
                    set('primaryZone', event.target.value as Zone);
                  }}
                >
                  {ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {ZONE_LABELS[zone]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </section>


        <div className="flex items-start gap-3 rounded-lg border border-border p-3">
          <Checkbox
            id="convert-invite"
            checked={form.sendInvitation}
            onChange={(event) => {
              set('sendInvitation', event.target.checked);
            }}
          />
          <div>
            <Label htmlFor="convert-invite">Send the welcome email now</Label>
            <p className="text-xs text-muted-foreground">
              {lead.contactName} gets their customer code and a sign-in link. Uncheck if you want to
              set up more sites first.
            </p>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/* ── Attachments (Matt, 5:53) ────────────────────────────────────────────── */

/**
 * PDF proposals filed against the lead.
 *
 * Matt, 5:53: *"if we're able to attach like a PDF file to those leads… we do
 * generate PDF proposals for some builders and it would help us keep track of
 * that."*
 *
 * ── Why it lives beside the notes and not on the account ──────────────────
 * A proposal exists before an account does, and it is what the office reaches
 * for when the builder rings back three weeks later asking what was quoted.
 * Filing it against the account it *might* become would leave every lead that
 * never converts with nowhere to keep it — and those are the ones you most often
 * need to look up.
 */
function LeadAttachments({ lead }: { lead: Lead }) {
  const toast = useToast();
  const attach = useLeadAttach();
  const detach = useLeadDetach();
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    try {
      await attach.mutateAsync({ id: lead.id, file });
      toast.success(`${file.name} attached`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error('Could not attach that file', described.detail ?? described.title);
    }
  };

  const remove = async (attachmentId: string, fileName: string) => {
    try {
      await detach.mutateAsync({ id: lead.id, attachmentId });
      toast.success(`${fileName} removed`);
    } catch (caught) {
      const described = describeError(caught);
      toast.error('Could not remove that file', described.detail ?? described.title);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Attachments</CardTitle>
        <p className="text-xs text-muted-foreground">
          Proposals and anything else sent to this lead. They stay with the lead whether or not it
          converts.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {lead.attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing attached yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {lead.attachments.map((file) => (
              <li key={file.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                <span className="flex min-w-0 items-center gap-2">
                  <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    {/*
                      A link only where there is genuinely something to open.
                      A dead download teaches whoever clicks it that the feature
                      does not work, which is worse than showing plain text.
                    */}
                    {file.url === null ? (
                      <span className="block truncate text-sm font-medium">{file.fileName}</span>
                    ) : (
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noreferrer"
                        className="focus-ring block truncate rounded text-sm font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {file.fileName}
                      </a>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {formatFileSize(file.sizeBytes)} · {file.uploadedBy} ·{' '}
                      {formatDateTime(file.uploadedAt)}
                    </span>
                  </span>
                </span>

                <Button
                  variant="ghost"
                  size="sm"
                  disabled={detach.isPending}
                  onClick={() => {
                    void remove(file.id, file.fileName);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {/*
          A real file input, hidden behind a button. The native control cannot be
          styled to match, and its "No file chosen" label is a lie on a list that
          already shows what is attached.
        */}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/*"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            // Cleared so re-picking the same file fires change again.
            event.target.value = '';
          }}
        />
        <Button
          variant="outline"
          disabled={attach.isPending}
          onClick={() => {
            inputRef.current?.click();
          }}
        >
          {attach.isPending ? <Spinner label="Attaching" /> : <PaperclipIcon aria-hidden />}
          Attach a file
        </Button>
      </CardContent>
    </Card>
  );
}

/** `148 KB`. Rounded hard — nobody needs the exact byte count of a proposal. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
