import type { Job, JobCompliance, SraUploadState } from '@plastago/shared';
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@plastago/ui';
import {
  ClipboardCheckIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { DetailList } from '@/components/detail-list';
import { formatDateTime } from '@/lib/format';

/**
 * M4.8 — the safety record, read back.
 *
 * ── Why this screen exists ────────────────────────────────────────────────
 * Drivers have always filled in a pre-start checklist, and on some sites a Site
 * Risk Assessment. Both were WRITE-ONLY: the forms went into the outbox and no
 * screen in the console ever showed them again. For a Chain of Responsibility
 * obligation that is precisely backwards — the record's entire purpose is being
 * produced when a builder, an auditor or an insurer asks for it, and a record
 * nobody can retrieve is not a record.
 *
 * ── Why it reads as answers, not as a form dump ───────────────────────────
 * Nobody opens this to admire fourteen green ticks. They open it because
 * somebody asked a question — "was that truck checked before it came to my
 * site", "did your driver assess the powerlines" — so each card leads with the
 * answer and shows the detail underneath. Passed pre-start items are collapsed
 * to a count for the same reason: the interesting line is the one that failed.
 *
 * ── What is deliberately NOT here ─────────────────────────────────────────
 * Any way to edit, approve or dismiss. Futile and contamination have queues
 * because money hangs on a human decision; this is evidence, and evidence the
 * office can amend is worth less than evidence it cannot.
 */
export function ComplianceTab({ job }: { job: Job }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/*
        `arrivedAt` is passed through because the assessment is filled in ON
        ARRIVAL. Without it a job that is merely BOOKED reads as a compliance
        failure — "required, and not completed" — for a visit that has not
        happened yet, which is both wrong and the kind of false alarm that
        teaches people to stop reading the tab.
      */}
      <RiskAssessmentCard compliance={job.compliance} arrivedAt={job.arrivedAt} />
      <PreStartCard compliance={job.compliance} />
    </div>
  );
}

const UPLOAD_STATE_LABELS: Record<SraUploadState, string> = {
  pending: 'Not sent yet',
  queued: 'Queued on the driver’s phone',
  uploaded: 'Uploaded to the builder',
  failed: 'Upload failed',
};

function RiskAssessmentCard({
  compliance,
  arrivedAt,
}: {
  compliance: JobCompliance;
  arrivedAt: string | null;
}) {
  const { riskAssessmentRequired, riskAssessment } = compliance;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon aria-hidden className="size-4 text-muted-foreground" />
          Site Risk Assessment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/*
          Three states, and they are NOT the same thing — which is the whole
          reason `riskAssessmentRequired` is stored beside the record rather than
          inferred from whether one exists. "Never needed one" is fine. "Needed
          one and has none" is the gap this tab was built to surface.
        */}
        {!riskAssessmentRequired && riskAssessment === null ? (
          <EmptyState
            icon={ShieldCheckIcon}
            title="Not required at this site"
            description="This builder does not ask for a written assessment. Set it on the account or the site if that changes."
          />
        ) : riskAssessment === null && arrivedAt === null ? (
          /*
            Required, but the driver has not arrived — so there is nothing to
            report yet. Stated plainly rather than left blank, because "required
            at this site" is itself the useful fact when the office is deciding
            who to send.
          */
          <Alert variant="info" title="Required at this site">
            The driver completes it when they arrive. Nothing to show until then — the form opens by
            itself and the job cannot be completed without it.
          </Alert>
        ) : riskAssessment === null ? (
          <Alert variant="warning" title="Required here, and not completed">
            The driver arrived but no assessment was submitted. Worth asking them before the builder
            does.
          </Alert>
        ) : (
          <>
            {riskAssessment.safeToProceed ? (
              <Badge variant="success">Driver judged the site safe</Badge>
            ) : (
              <Alert variant="destructive" title="Driver stopped work — site unsafe">
                {riskAssessment.note || 'The driver judged the site unsafe and did not proceed.'}
              </Alert>
            )}

            <DetailList
              columns={2}
              items={[
                { label: 'Completed', value: formatDateTime(riskAssessment.completedAt) },
                { label: 'By', value: riskAssessment.driverName },
                {
                  label: 'Hazards identified',
                  value: riskAssessment.hazards.join(' · '),
                  wide: true,
                },
                {
                  label: 'Controls applied',
                  value: riskAssessment.controls.join(' · '),
                  wide: true,
                },
                { label: 'SWMS version', value: riskAssessment.swmsVersion },
                {
                  // Step 4 of the five-step workflow — scanned off the fence.
                  label: 'Builder site code',
                  value: riskAssessment.builderPortalCode ?? 'No QR sign at this site',
                },
                ...(riskAssessment.safeToProceed && riskAssessment.note
                  ? [{ label: 'Note', value: riskAssessment.note, wide: true }]
                  : []),
              ]}
            />

            {/*
              Step 5 is the only one that touches SOMEBODY ELSE'S system, so it
              is the one that fails — and a failure here is invisible to the
              driver, who has long since driven away.
            */}
            {riskAssessment.uploadState === 'failed' ? (
              <Alert variant="destructive" title="Did not reach the builder’s portal">
                The assessment is recorded here, but the handoff failed. It needs uploading by hand.
              </Alert>
            ) : (
              <p className="text-xs text-muted-foreground">
                Builder portal: {UPLOAD_STATE_LABELS[riskAssessment.uploadState]}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PreStartCard({ compliance }: { compliance: JobCompliance }) {
  const { preStart } = compliance;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheckIcon aria-hidden className="size-4 text-muted-foreground" />
          Pre-start check
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {preStart === null ? (
          /*
            Not a gap. The pre-start belongs to a RUN, so a job with no driver
            allocated has nothing to show — saying "not done" would accuse
            somebody of missing a check that was never theirs to do.
          */
          <EmptyState
            icon={ClipboardCheckIcon}
            title="No run yet"
            description="The pre-start check is recorded when the driver starts their day. This job has not been on a run."
          />
        ) : (
          <>
            {preStart.failedItems.length === 0 ? (
              <Badge variant="success">All {preStart.itemsChecked} checks passed</Badge>
            ) : (
              <Alert
                variant="warning"
                title={`${String(preStart.failedItems.length)} item${preStart.failedItems.length === 1 ? '' : 's'} failed`}
              >
                <ul className="space-y-1">
                  {preStart.failedItems.map((item) => (
                    <li key={item.key} className="flex gap-2">
                      <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <span className="font-medium">{item.label}</span>
                        {item.note ? ` — ${item.note}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Alert>
            )}

            <DetailList
              columns={2}
              items={[
                { label: 'Completed', value: formatDateTime(preStart.completedAt) },
                { label: 'By', value: preStart.driverName },
                { label: 'Vehicle', value: preStart.vehicleRego || '—' },
                {
                  label: 'Odometer',
                  value: `${preStart.odometerKm.toLocaleString('en-AU')} km`,
                },
              ]}
            />

            {preStart.failedItems.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />A failed item
                should also appear as a defect against the vehicle — check Vehicles if it has not
                been booked in.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
