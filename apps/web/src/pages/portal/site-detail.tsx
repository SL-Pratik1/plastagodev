import { zodResolver } from '@hookform/resolvers/zod';
import { ZONE_LABELS, type PortalSite } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Label,
  Skeleton,
  Spinner,
  Textarea,
  buttonVariants,
  useToast,
} from '@plastago/ui';
import { CheckIcon, CopyIcon, PlusCircleIcon, SaveIcon, Share2Icon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router';
import * as z from 'zod';
import { DetailList } from '@/components/detail-list';
import { usePortalSite, usePortalUpdateSite } from '@/features/portal/queries';
import { describeError } from '@/lib/error-message';
import { formatDate, formatMobile } from '@/lib/format';

/**
 * One site (M5.3 · W87, W98 and M5.6 · F46, W92).
 *
 * ── Everything on this page prevents a futile pickup ──────────────────────
 * Access notes, gate hours, induction, crane availability, who to ring — each
 * one is a reason a driver would otherwise arrive and be unable to collect. M5.3
 * puts it in the customer's hands because they are the only ones who know when
 * the gate code changes, and because both sides pay for getting it wrong.
 *
 * ── B.1's shareable link is on this page, prominently ─────────────────────
 * *"Expected to be the dominant route in."* A supervisor pastes it into the site
 * WhatsApp group; the next person taps it, enters their mobile, gets an SMS code
 * and books — under a minute, on a phone, on site. So the link gets a copy
 * button and an explanation of what it does, not a footnote.
 */
const FormSchema = z.object({
  accessNotes: z.string().trim().max(1000),
  gateHours: z.string().trim().max(120),
  inductionRequired: z.boolean(),
  craneAvailable: z.boolean(),
  siteContactName: z.string().trim().max(80),
  siteContactMobile: z
    .string()
    .trim()
    .max(20)
    .refine(
      (value) => value === '' || /^(?:\+?61|0)4\d{8}$/.test(value.replace(/[\s()-]/g, '')),
      'Enter an Australian mobile, e.g. 0412 345 678',
    ),
  preferredWindow: z.string().trim().max(120),
  blackoutNote: z.string().trim().max(300),
});

type FormValues = z.infer<typeof FormSchema>;

export function PortalSiteDetailPage() {
  const { siteId } = useParams();
  const { data: site, error, isPending, refetch } = usePortalSite(siteId);

  if (error) {
    const described = describeError(error);
    return (
      <ErrorState
        title={described.title}
        description={described.detail}
        onRetry={described.retryable ? () => void refetch() : undefined}
      />
    );
  }

  if (isPending || !site) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-7 w-56" />
        <Card className="p-5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-48 w-full" />
        </Card>
      </div>
    );
  }

  // `key` remounts the form when a different site loads, so the inputs cannot
  // hold the previous site's values — the alternative is mirroring props into
  // state with an effect, which the React Compiler rightly rejects.
  return <SiteDetail key={site.id} site={site} />;
}

function SiteDetail({ site }: { site: PortalSite }) {
  const toast = useToast();
  const update = usePortalUpdateSite();
  const [copied, setCopied] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onTouched',
    defaultValues: {
      accessNotes: site.accessNotes,
      gateHours: site.gateHours ?? '',
      inductionRequired: site.inductionRequired,
      craneAvailable: site.craneAvailable,
      siteContactName: site.siteContactName ?? '',
      siteContactMobile: site.siteContactMobile ?? '',
      preferredWindow: site.preferredWindow ?? '',
      blackoutNote: site.blackoutNote ?? '',
    },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await update.mutateAsync({ id: site.id, input: values });
      toast.success('Site updated', 'Our drivers will see this on their run sheet.');
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(site.bookingLink);
      setCopied(true);
      toast.success('Link copied', 'Paste it into your site group — no app, no password.');
      // Reverts the button label; a permanent tick would suggest the link is
      // somehow "done" rather than copied.
      window.setTimeout(() => {
        setCopied(false);
      }, 2500);
    } catch {
      // Clipboard access is denied in some contexts; the input below is
      // selectable, so there is always a way to get the link.
      toast.error('Could not copy automatically', 'Select the link below and copy it.');
    }
  };

  return (
    <div className="space-y-5">
      <Link
        to="/portal/sites"
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← All sites
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-semibold tracking-tight">{site.name}</h1>
          <p className="text-sm text-muted-foreground">
            {site.addressLine}, {site.suburb} {site.postcode}
          </p>
        </div>
        <Link
          to={`/portal/book?site=${site.id}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <PlusCircleIcon aria-hidden />
          Book for this site
        </Link>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Getting a truck in</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Our driver reads this before they leave the depot. The more specific it is, the
                  less likely a pickup fails.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  id="site-access-notes"
                  label="Access notes"
                  error={errors.accessNotes?.message}
                  hint="Where the pile is, which entrance, gate codes, anything a first-time driver would not guess."
                >
                  {(control) => (
                    <Textarea
                      {...control}
                      rows={4}
                      placeholder="Second entrance off the roundabout — main gate is fenced off. Board is behind the garage. Gate code 4417."
                      {...register('accessNotes')}
                    />
                  )}
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="site-gate-hours"
                    label="Gate hours"
                    error={errors.gateHours?.message}
                    hint="When a truck can actually get on site."
                  >
                    {(control) => (
                      <Input
                        {...control}
                        placeholder="Mon–Fri 6:30am–3:30pm"
                        {...register('gateHours')}
                      />
                    )}
                  </Field>

                  <Field
                    id="site-preferred-window"
                    label="Preferred pickup window"
                    error={errors.preferredWindow?.message}
                    hint="We will aim for this — it is a preference, not a guarantee."
                  >
                    {(control) => (
                      <Input
                        {...control}
                        placeholder="Mornings before the concrete pour"
                        {...register('preferredWindow')}
                      />
                    )}
                  </Field>
                </div>

                <Field
                  id="site-blackout"
                  label="Days or times to avoid"
                  error={errors.blackoutNote?.message}
                  hint="Crane days, pours, inspections — anything that blocks a truck."
                >
                  {(control) => (
                    <Input
                      {...control}
                      placeholder="No access Wednesdays — crane on site"
                      {...register('blackoutNote')}
                    />
                  )}
                </Field>

                <div className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox id="site-induction" {...register('inductionRequired')} />
                    <div>
                      <Label htmlFor="site-induction" className="font-normal">
                        Site induction required
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        We will send an inducted driver, or arrange the induction first.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox id="site-crane" {...register('craneAvailable')} />
                    <div>
                      <Label htmlFor="site-crane" className="font-normal">
                        Crane available on site
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Changes how the load is handled and how long we are on site.
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Who the driver calls</CardTitle>
                <p className="text-xs text-muted-foreground">
                  A number that answers on site beats head office every time.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="site-contact-name"
                    label="Site contact"
                    error={errors.siteContactName?.message}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        placeholder="Dave Nguyen"
                        {...register('siteContactName')}
                      />
                    )}
                  </Field>

                  <Field
                    id="site-contact-mobile"
                    label="Mobile"
                    error={errors.siteContactMobile?.message}
                    hint="We text them when the driver is 20 minutes out."
                  >
                    {(control) => (
                      <Input
                        {...control}
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        placeholder="0412 345 678"
                        {...register('siteContactMobile')}
                      />
                    )}
                  </Field>
                </div>
              </CardContent>
            </Card>

            <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-card/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
              {isDirty && (
                <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span>
              )}
              <Button type="submit" disabled={isSubmitting || !isDirty}>
                {isSubmitting && <Spinner label="Saving" />}
                <SaveIcon aria-hidden />
                Save site details
              </Button>
            </div>
          </form>
        </div>

        <div className="space-y-5">
          {/* ── B.1 · the shareable booking link ─────────────────────── */}
          <Card className="border-primary/35">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Share2Icon aria-hidden className="size-4 text-primary" />
                Share this site
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Anyone with this link can book a pickup <strong>for this site only</strong>. They
                enter their mobile, get a code by text, and they are in — no app, no password.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                readOnly
                value={site.bookingLink}
                aria-label="Booking link for this site"
                className="font-mono text-xs"
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void copyLink()}
              >
                {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Paste it into your site WhatsApp group or hand it out at induction.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Site record</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={1}
                items={[
                  { label: 'Lot number', value: site.lotNumber ?? '—' },
                  { label: 'Builder on site', value: site.builderName || '—' },
                  { label: 'Service zone', value: ZONE_LABELS[site.zone] },
                  {
                    label: 'Pickups booked',
                    value:
                      site.openJobCount > 0 ? (
                        <Badge variant="default">{site.openJobCount}</Badge>
                      ) : (
                        'None'
                      ),
                  },
                  { label: 'Pickups to date', value: site.totalJobCount },
                  { label: 'Last pickup', value: formatDate(site.lastJobAt) },
                  {
                    label: 'Site contact on file',
                    value: site.siteContactMobile
                      ? formatMobile(site.siteContactMobile)
                      : 'Not set',
                  },
                ]}
              />
            </CardContent>
          </Card>

          {!site.accessNotes && (
            <Alert variant="warning" title="No access notes on this site">
              This is the most common reason a driver rings from outside a gate. Two lines here
              saves a phone call and sometimes a $120 futile fee.
            </Alert>
          )}
        </div>
      </div>
    </div>
  );
}
