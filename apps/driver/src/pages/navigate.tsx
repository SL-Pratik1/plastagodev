import { Alert, Badge, ErrorState, Skeleton, buttonVariants } from '@plastago/ui';
import { ExternalLinkIcon, NavigationIcon, PhoneIcon } from 'lucide-react';
import { Link, useParams } from 'react-router';
import {
  MAPS_EMBED_ENABLED,
  directionsEmbedUrl,
  externalDirectionsUrl,
} from '@/config/maps';
import { useDriverJob } from '@/features/run/queries';

/**
 * Navigation, in the app (I3).
 *
 * ── Why this screen exists at all ─────────────────────────────────────────
 * The Navigate button used to hand the driver to the Google Maps application.
 * That ends the run: the phone is in another app, the job's photo prompts and
 * weight capture are behind an app switch, and returning depends on the driver
 * remembering to. The driver surface is built as one screen at a time, and an
 * app switch is the largest possible violation of that.
 *
 * ── The address is above the map, not below it ────────────────────────────
 * In a half-built estate the map pin is the more useful of the two right up
 * until it is not, and then the LOT NUMBER is the only thing that identifies the
 * site — there is no street number on the ground yet. So the written address and
 * the lot lead, and the map supports them.
 *
 * ── What happens without a key ────────────────────────────────────────────
 * The embed needs a billed Google key this build does not have. Rather than
 * render something map-shaped that is not a map, the screen shows the
 * destination detail and the hand-off that does work. Nothing else changes when
 * the key arrives.
 */
export function DriverNavigatePage() {
  const { jobId } = useParams();
  const { data: job, error, isPending, refetch } = useDriverJob(jobId);

  if (error) {
    return (
      <ErrorState
        title="Could not open this job"
        description="You may be out of coverage. Go back to your run and try again."
        onRetry={() => void refetch()}
      />
    );
  }

  if (isPending || !job) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const embedUrl = directionsEmbedUrl(job.latitude, job.longitude);
  const externalUrl = externalDirectionsUrl(job.latitude, job.longitude);

  return (
    <div className="space-y-4">
      <Link
        to={`/jobs/${job.jobId}`}
        className="focus-ring inline-block rounded text-sm text-muted-foreground underline-offset-4"
      >
        ← Back to the job
      </Link>

      <header className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          Job {job.sequence} · #{job.jobNumber}
        </p>
        <h1 className="font-display text-lg leading-tight font-semibold">{job.siteName}</h1>
        {/*
          Lot number first and prominent: in a greenfield estate the street
          number does not exist yet, and the lot is how the site is identified
          on the ground.
        */}
        <p className="text-sm">
          {job.lotNumber !== null && <span className="font-semibold">Lot {job.lotNumber} · </span>}
          {job.addressLine}, {job.suburb} {job.postcode}
        </p>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {job.inductionRequired && <Badge variant="warning">Induction</Badge>}
          {job.craneAvailable && <Badge variant="secondary">Crane on site</Badge>}
        </div>
      </header>

      {embedUrl !== null ? (
        <div className="overflow-hidden rounded-xl border border-border">
          <iframe
            title={`Directions to ${job.siteName}`}
            src={embedUrl}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allow="geolocation"
            className="block h-[60vh] w-full border-0"
          />
        </div>
      ) : (
        <Alert variant="info" title="The in-app map is not switched on yet">
          It needs a Google Maps key on this environment. Until then, tap below to open directions
          in your phone&rsquo;s maps app — come back here when you arrive.
        </Alert>
      )}

      {job.accessNotes !== '' && (
        <div className="rounded-xl border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">Getting in</p>
          <p className="mt-1 text-sm">{job.accessNotes}</p>
        </div>
      )}

      <div className="grid gap-2">
        {/*
          Kept even when the embed works. A driver who wants turn-by-turn voice
          in the car should have it — the point was never to trap them here, it
          was to stop the app switch being the only way to see the route.
        */}
        <a
          href={externalUrl}
          target="_blank"
          rel="noreferrer"
          className={`${buttonVariants({ variant: MAPS_EMBED_ENABLED ? 'outline' : 'default', size: 'lg' })} min-h-14`}
        >
          {MAPS_EMBED_ENABLED ? <ExternalLinkIcon aria-hidden /> : <NavigationIcon aria-hidden />}
          Open in the maps app
        </a>

        {job.siteContactMobile !== null && (
          <a
            href={`tel:${job.siteContactMobile}`}
            className={`${buttonVariants({ variant: 'outline', size: 'lg' })} min-h-14`}
          >
            <PhoneIcon aria-hidden />
            {job.siteContactName ?? 'Site contact'}
          </a>
        )}
      </div>
    </div>
  );
}
