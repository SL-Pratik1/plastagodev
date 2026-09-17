import { zodResolver } from '@hookform/resolvers/zod';
import {
  LEAD_ATTACHABLE_TYPES,
  LEAD_ATTACHMENT_ACCEPT,
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  MAX_UPLOAD_BYTES,
  type LeadCreate,
} from '@plastago/shared';
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  buttonVariants,
  useToast,
} from '@plastago/ui';
import { FileTextIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import * as z from 'zod';
import { useSelectableZones } from '@/features/lookups/queries';
import { PageHeader } from '@/components/page-header';
import { useLeadAttach, useLeadCreate } from '@/features/queues/queries';
import { describeError } from '@/lib/error-message';
import { formatFileSize } from '@/lib/format';
import { isServiceError } from '@/services/service-error';

/**
 * A.1 — take a lead by hand.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * The leads queue could read, progress and convert a lead but never create one:
 * the only door in was the public enquiry form. Meanwhile `LEAD_SOURCES` listed
 * `phone`, `referral` and `other`, and the grid offered a filter for each —
 * three filters over rows that could not exist. Matt takes those calls on
 * 1300 395 438; before this screen they lived in a notebook, or got typed
 * straight in as a job, which is the "leads arrive disguised as jobs" problem
 * the queue exists to end.
 *
 * ── Why the form is mostly optional ────────────────────────────────────────
 * This is a phone screen, not a web form. The caller is on the line, and a
 * required "expected frequency" is a reason to abandon the record and lose the
 * lead entirely — so only what makes the lead *chaseable* is required: who they
 * are and how to reach them. Everything that shapes the eventual quote can be
 * filled in on the second call, from the detail screen. A thin lead in the
 * queue beats a perfect one in a notebook.
 *
 * ⚠️ There is no status field, and that is not an oversight. Every lead starts
 * `new`. A form that could create one already `won` would be a way to mint a won
 * lead with no account, no rate card and no terms behind it — which is exactly
 * what A.4 exists to prevent.
 *
 * ⚠️ No `can()` guard anywhere on this screen. The route already sits behind
 * `RequireCapability capability="leads:manage"`, so a second check would be a
 * branch that can never be false — and a dead permission check is worse than
 * none, because the next reader believes it is load-bearing.
 */

/**
 * The form's own shape, not `LeadCreateSchema`.
 *
 * Selects and number inputs hand back strings, and two fields here are nullable
 * in the domain — a zone (`null` = we probably cannot service them) and a volume
 * (`null` = they did not say). Binding the domain schema straight to the inputs
 * would mean coercing '' into `null` inside the resolver and hoping; instead the
 * form validates what the browser actually produces, and `toLead` does the one
 * conversion, in one place, where it can be read.
 */
const FormSchema = z.object({
  companyName: z.string().trim().min(1, 'Enter the company name').max(120, 'Keep the company name under 120 characters'),
  contactName: z.string().trim().min(1, 'Enter who you spoke to').max(80, 'Keep the contact name under 80 characters'),
  email: z.email('Enter a valid email address').max(160, 'Keep the email under 160 characters'),
  mobile: z.string().trim().max(20, 'A mobile number is at most 20 characters'),
  source: z.enum(LEAD_SOURCES),
  /**
   * '' is "outside the service area" — the same answer the grid filters on.
   *
   * ⚠️ A bare string now, not `z.enum(ZONES)`. Zones are records an
   * administrator creates, so there is no closed set to check against here and
   * the server is the authority on whether an id names one. What this still
   * guarantees is the thing the form cares about: '' is a deliberate answer,
   * not a missing one.
   */
  zoneId: z.string(),
  suburbs: z.string().trim().max(200, 'Keep the suburb list under 200 characters'),
  /**
   * Kept as a string so '' survives as its own answer. `z.coerce.number()` turns
   * '' into 0, and 0 m² is a claim the caller never made — it would render as
   * "0 m²" on the grid and quietly misprice the eventual quote.
   */
  typicalVolumeM2: z
    .string()
    .trim()
    .refine((value) => value === '' || Number.isFinite(Number(value)), 'Enter a number')
    .refine((value) => value === '' || Number(value) >= 0, 'Square metres cannot be negative')
    .refine(
      (value) => value === '' || Number(value) <= 100000,
      'That looks too large — check the figure',
    ),
  expectedFrequency: z.string().trim().max(80, 'Keep this under 80 characters'),
  heardAbout: z.string().trim().max(200, 'Keep this under 200 characters'),
  ownerName: z.string().trim().max(80, 'Keep the name under 80 characters'),
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters'),
});

type FormValues = z.input<typeof FormSchema>;

function toLead(values: FormValues): LeadCreate {
  const volume = values.typicalVolumeM2.trim();
  return {
    ...values,
    zoneId: values.zoneId === '' ? null : values.zoneId,
    typicalVolumeM2: volume === '' ? null : Number(volume),
  };
}

export function AdminQueueLeadCreatePage() {
  const navigate = useNavigate();
  /* Live zones only: a new lead is never captured against a retired one. */
  const zones = useSelectableZones();
  const toast = useToast();
  const createLead = useLeadCreate();
  const attach = useLeadAttach();

  /**
   * Files chosen before the lead exists.
   *
   * ── Why they are held here and not uploaded as they are picked ────────────
   * An attachment is stored under a key built from the lead's id, and there is
   * no id until the lead is saved. The alternatives were a staging area on the
   * server with something to sweep up whatever is never claimed, or refusing to
   * offer the field at all — and the office has the proposal open while they are
   * still on the call, which is the moment it is worth capturing.
   *
   * ⚠️ So the save is two steps, and the second one can fail on its own. The
   * lead is never rolled back if an upload fails: the lead is the valuable part,
   * the file can be attached again from the detail screen.
   */
  const [staged, setStaged] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Checked here as well as on the server.
   *
   * Not defence — the server is the authority. It is about *when* somebody is
   * told: refusing a 30 MB file the moment it is picked costs nothing, whereas
   * discovering it after the lead is saved means an error toast attached to a
   * screen that has already navigated away.
   */
  const stageFiles = (picked: File[]) => {
    const accepted: File[] = [];

    for (const file of picked) {
      if (staged.some((held) => held.name === file.name && held.size === file.size)) continue;

      if (file.size === 0) {
        toast.error(`${file.name} is empty`, 'The file has no contents.');
        continue;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(
          `${file.name} is too large`,
          `Attachments must be under ${String(Math.round(MAX_UPLOAD_BYTES / 1024 / 1024))} MB.`,
        );
        continue;
      }

      /*
       * An empty `file.type` is allowed through. Windows reports nothing for a
       * .docx with no handler registered, and the service layer recovers the
       * type from the extension — rejecting it here would block a real file the
       * upload would have accepted.
       */
      if (file.type !== '' && !(LEAD_ATTACHABLE_TYPES as readonly string[]).includes(file.type)) {
        toast.error(
          `${file.name} cannot be attached`,
          'Attach a PDF, a Word document or an image.',
        );
        continue;
      }

      accepted.push(file);
    }

    if (accepted.length > 0) setStaged((held) => [...held, ...accepted]);
  };

  const unstage = (file: File) => {
    setStaged((held) => held.filter((each) => each !== file));
  };

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      companyName: '',
      contactName: '',
      email: '',
      mobile: '',
      // Not 'enquiry-form'. Anything typed on this screen arrived some other way
      // — that is the entire reason the screen exists — and defaulting to the
      // web form would poison the one number this queue was built to answer:
      // where our enquiries actually come from.
      source: 'phone',
      zoneId: '',
      suburbs: '',
      typicalVolumeM2: '',
      expectedFrequency: '',
      heardAbout: '',
      ownerName: '',
      note: '',
    },
    mode: 'onTouched',
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const lead = await createLead.mutateAsync(toLead(values));

      /*
       * The lead exists from here on, so nothing below is allowed to throw out
       * of this block — a failed upload must not be reported as a failed save,
       * and must not stop the navigation. Sequential rather than parallel: each
       * upload is a presign, a PUT and a re-read, and firing five at once on a
       * site office's connection is how the slowest of them times out.
       */
      const failed: string[] = [];
      for (const file of staged) {
        try {
          await attach.mutateAsync({ id: lead.id, file });
        } catch {
          failed.push(file.name);
        }
      }

      if (failed.length === 0) {
        toast.success(
          `${lead.companyName} added to the queue`,
          'Logged as a new lead. Progress it, or convert it to an account once the terms are agreed.',
        );
      } else {
        // Named, not counted. "2 files failed" leaves somebody comparing lists.
        toast.error(
          `${lead.companyName} was saved, but not everything attached`,
          `${failed.join(', ')} did not upload. Attach ${failed.length === 1 ? 'it' : 'them'} again from the lead.`,
        );
      }

      // Straight to the detail screen rather than back to the grid: the call is
      // usually not over, and the next thing wanted is the note thread.
      await navigate(`/admin/queues/leads/${lead.id}`);
    } catch (caught) {
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        for (const [field, message] of Object.entries(caught.fieldErrors)) {
          setError(field as keyof FormValues, { type: 'server', message });
        }
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumbs={[{ label: 'Queues' }, { label: 'Leads', to: '/admin/queues/leads' }]}
        title="New lead"
        description="For an enquiry that did not come through the website — a phone call, a referral, a conversation on site. Only the company and how to reach them are required; the rest can wait for the second call."
      />

      <form onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Who they are</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Enough to ring them back. This is the only part that is required.
                </p>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  id="lead-company"
                  label="Company"
                  required
                  error={errors.companyName?.message}
                  className="sm:col-span-2"
                  hint="The trading name they gave you — the registered name is asked for at conversion."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('companyName')}
                      placeholder="Hunter Valley Homes"
                    />
                  )}
                </Field>

                <Field
                  id="lead-contact"
                  label="Contact"
                  required
                  error={errors.contactName?.message}
                >
                  {(aria) => (
                    <Input {...aria} {...register('contactName')} placeholder="Rachel Nguyen" />
                  )}
                </Field>

                <Field id="lead-email" label="Email" required error={errors.email?.message}>
                  {(aria) => (
                    <Input
                      {...aria}
                      type="email"
                      {...register('email')}
                      placeholder="rachel@hvhomes.com.au"
                    />
                  )}
                </Field>

                <Field
                  id="lead-mobile"
                  label="Mobile"
                  error={errors.mobile?.message}
                  hint="Optional. Left blank, the queue shows them as email only."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="tel"
                      {...register('mobile')}
                      placeholder="0412 345 678"
                    />
                  )}
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>What they need</CardTitle>
                <p className="text-xs text-muted-foreground">
                  All optional, and all of it is what the quote will turn on. Whatever they said on
                  the call is worth more than a blank field.
                </p>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  id="lead-zone"
                  label="Zone"
                  error={errors.zoneId?.message}
                  hint="Which service area they fall in."
                >
                  {(aria) => (
                    <Select {...aria} {...register('zoneId')}>
                      {zones.map((zone) => (
                        <option key={zone.value} value={zone.value}>
                          {zone.label}
                        </option>
                      ))}
                      {/* A real answer, not a blank one: a lead we probably
                          cannot service is still worth recording, and the grid
                          filters for exactly this case. */}
                      <option value="">Outside the service area</option>
                    </Select>
                  )}
                </Field>

                <Field
                  id="lead-suburbs"
                  label="Suburbs"
                  error={errors.suburbs?.message}
                  hint="Where they build. Comma separated."
                >
                  {(aria) => (
                    <Input {...aria} {...register('suburbs')} placeholder="Maitland, Cessnock" />
                  )}
                </Field>

                <Field
                  id="lead-volume"
                  label="Typical volume (m²)"
                  error={errors.typicalVolumeM2?.message}
                  hint="Per pickup. Leave blank if they did not say — blank is not zero."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={10}
                      {...register('typicalVolumeM2')}
                      placeholder="900"
                    />
                  )}
                </Field>

                <Field
                  id="lead-frequency"
                  label="Expected frequency"
                  error={errors.expectedFrequency?.message}
                  hint="In their words."
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('expectedFrequency')}
                      placeholder="2–3 pickups a week"
                    />
                  )}
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>The call</CardTitle>
                <p className="text-xs text-muted-foreground">
                  What was said and what happens next. Becomes the first entry in the note thread.
                </p>
              </CardHeader>
              <CardContent>
                <Field id="lead-note" label="Note" error={errors.note?.message}>
                  {(aria) => (
                    <Textarea
                      {...aria}
                      rows={4}
                      maxLength={1000}
                      {...register('note')}
                      placeholder="Rang about weekly pickups out of Maitland — roughly 900 m². Sending Tier 2 pricing, calling back Thursday."
                    />
                  )}
                </Field>
              </CardContent>
            </Card>

            {/*
              Attachments, staged (Matt, 5:53).

              The same card as the detail screen, with one honest difference:
              nothing is uploaded until the lead is saved, because the file is
              stored under the lead's id and there is not one yet. The card says
              so rather than showing a spinner over a lead that does not exist.
            */}
            <Card>
              <CardHeader>
                <CardTitle>Attachments</CardTitle>
                <p className="text-xs text-muted-foreground">
                  A proposal already drafted, or anything emailed to them. Uploaded when the lead is
                  saved, and it stays with the lead whether or not it converts.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                {staged.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing chosen. Optional — files can be attached later from the lead.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {staged.map((file) => (
                      <li
                        key={`${file.name}:${String(file.size)}`}
                        className="flex items-center justify-between gap-3 py-2 first:pt-0"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <FileTextIcon
                            aria-hidden
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{file.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {formatFileSize(file.size)} · uploads when you save
                            </span>
                          </span>
                        </span>

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isSubmitting}
                          onClick={() => {
                            unstage(file);
                          }}
                        >
                          <XIcon aria-hidden />
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Hidden real input, same reasoning as the detail screen: the
                    native control cannot be styled, and its "No file chosen"
                    label contradicts the list above it. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={LEAD_ATTACHMENT_ACCEPT}
                  className="sr-only"
                  onChange={(event) => {
                    stageFiles([...(event.target.files ?? [])]);
                    // Cleared so re-picking the same file fires change again.
                    event.target.value = '';
                  }}
                />
                {/*
                  ⚠️ `type="button"`. Inside a form, a button with no type
                  submits it — this one would create the lead instead of opening
                  the file picker.
                */}
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                >
                  <PaperclipIcon aria-hidden />
                  Choose files
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Where it came from</CardTitle>
                <p className="text-xs text-muted-foreground">
                  The only reason the queue can answer how many enquiries we got and how many
                  converted.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field id="lead-source" label="Source" required error={errors.source?.message}>
                  {(aria) => (
                    <Select {...aria} {...register('source')}>
                      {LEAD_SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {LEAD_SOURCE_LABELS[source]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>

                <Field
                  id="lead-heard"
                  label="How they heard about us"
                  error={errors.heardAbout?.message}
                >
                  {(aria) => (
                    <Input
                      {...aria}
                      {...register('heardAbout')}
                      placeholder="Referred by Everton Homes"
                    />
                  )}
                </Field>

                {/* Free text, matching the detail screen's owner field and
                    `LeadUpdate`. A picker would mean a hardcoded staff list in a
                    second place, and the two would drift the first time somebody
                    joins. */}
                <Field
                  id="lead-owner"
                  label="Owner"
                  error={errors.ownerName?.message}
                  hint="Who is chasing it. Leave empty to put it in the pool — the grid flags it unassigned."
                >
                  {(aria) => (
                    <Input {...aria} {...register('ownerName')} placeholder="Matthew Browne" />
                  )}
                </Field>
              </CardContent>
            </Card>

            <Alert variant="info" title="This creates a lead, not a job">
              Nothing here can be priced or scheduled. It becomes bookable only once it is converted
              to an account — which is where the rate card, the PO policy and the payment terms get
              agreed.
            </Alert>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Spinner label="Saving" />}
                Add lead
              </Button>
              <Link to="/admin/queues/leads" className={buttonVariants({ variant: 'outline' })}>
                Cancel
              </Link>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
