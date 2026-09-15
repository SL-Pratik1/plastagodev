import {
  LEAD_ATTACHMENT_ACCEPT,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  LEAD_WORKABLE_STATUSES,
  ZONE_LABELS,
  type Lead,
  type LeadWorkableStatus,
} from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
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
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { DetailList } from '@/components/detail-list';
import { PageHeader } from '@/components/page-header';
import { AgeBadge } from '@/components/queues/age-badge';
import { useLead, useLeadAttach, useLeadDetach, useLeadUpdate } from '@/features/queues/queries';
import { ConvertLeadDialog } from '@/features/queues/components/convert-lead-dialog';
import { describeError } from '@/lib/error-message';
import { formatArea, formatDateTime, formatFileSize, formatMobile } from '@/lib/format';

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
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
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

  const [status, setStatus] = useState<LeadWorkableStatus>(
    // A converted lead is read-only below, so the cast only ever meets a
    // workable value in practice.
    lead.status === 'won' ? 'quoted' : lead.status,
  );
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
            // The account this lead BECAME, not the list of all of them. Landing
            // on the grid left the reader to find it by name, which is the same
            // dead end the row's old "Account created" label was.
            <Link
              to={`/admin/customers/${lead.convertedAccountId ?? ''}`}
              className={buttonVariants({ variant: 'outline' })}
            >
              <BuildingIcon aria-hidden />
              View the account
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
          This lead became an account. Pricing and terms were set during conversion — change them on
          the account, not here.
        </Alert>
      )}

      {lead.zone === null && !converted && (
        <Alert variant="warning" title="Outside the three service zones">
          {lead.suburbs} is not in Sydney, Wollongong or Newcastle. Confirm we can actually service
          it before quoting — an account we cannot reach is worse than a lost lead.
        </Alert>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
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
                    setStatus(event.target.value as LeadWorkableStatus);
                  }}
                >
                  {/*
                    ⚠️ The WORKABLE statuses, not all of them. `won` is absent
                    from this list for the reason the shared schema gives: a lead
                    is won when it becomes an ACCOUNT, which happens on Convert
                    below, where the customer code, the rate card and the terms
                    are decided.

                    This dropdown used to offer every status, so picking "Won"
                    sent a value `LeadUpdateSchema` refuses and the office got a
                    bare "Request validation failed" with no way to tell what it
                    objected to. A TypeScript error should have caught it and did
                    not, because the built `@plastago/shared` on disk predated
                    `won` being removed from the writable set.
                  */}
                  {LEAD_WORKABLE_STATUSES.map((option) => (
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

            {/*
              There was an alert here saying "Marking a lead won does not create
              the account", shown once somebody had already chosen Won. It was
              explaining a choice the form should not have offered — and the save
              behind it failed anyway. The dropdown no longer lists Won, so there
              is nothing left to explain after the fact; "Convert to account" in
              the header is the only way a lead is won.
            */}
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
          accept={LEAD_ATTACHMENT_ACCEPT}
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
