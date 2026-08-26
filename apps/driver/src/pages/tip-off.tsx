import {
  Alert,
  Field,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  buttonVariants,
  cn,
  useToast,
} from '@plastago/ui';
import { CameraIcon, CheckCircle2Icon, ScaleIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useRecordTipOff, useRunSheet, useTipOffPreview } from '@/features/run/queries';
import { RUN_DATE } from '@/services/mock/fixtures';
import { currentPosition } from '@/services/mock/create-mock-services';

/**
 * Tip-off weight and end-of-run reconciliation (M4.4).
 *
 * ── Why this screen exists at all ─────────────────────────────────────────
 * Because **not every job can be weighed**, and that is the whole point. Roughly
 * 60–70% of jobs are bagged and get weighed on the crane scale; 30%+ are
 * hand-loaded and cannot be weighed — there is no bag to lift. So the load is
 * weighed once, at the facility, and the difference is spread across the jobs
 * that had no measurement:
 *
 * ```
 *   tip-off total          weighbridge
 * − measured crane weights bagged jobs
 * = remainder ÷ hand-load jobs = imputed weight each
 * ```
 *
 * ── Why the driver sees the arithmetic ────────────────────────────────────
 * Matt's purpose for this is explicitly **not billing** — it is costing, mass
 * balance, EPA RRO14 records, and the tonnes-diverted figure printed on customers'
 * diversion certificates for Green Star submissions. A wrong number here ends up
 * in a document that has to survive an audit.
 *
 * And a wildly wrong imputed figure almost always means a mistyped crane weight.
 * The driver is standing at the weighbridge and can still fix it — which they
 * cannot do if the calculation happens silently after they drive away.
 */
export function TipOffPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: day } = useRunSheet(RUN_DATE);
  const record = useRecordTipOff();

  const [totalKg, setTotalKg] = useState('');
  const [docket, setDocket] = useState('');
  const [docketPhotoId, setDocketPhotoId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const parsed = Number(totalKg);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const preview = useTipOffPreview(RUN_DATE, valid ? parsed : 0, valid);

  const alreadyDone = day?.tipOffRecordedAt !== null && day?.tipOffRecordedAt !== undefined;

  const save = async () => {
    const next: Record<string, string> = {};
    if (!valid) {
      next.total = 'Enter the weighbridge figure in kilograms.';
    } else if (parsed > 50000) {
      next.total = 'That is heavier than the truck. Check the docket.';
    }
    if (docketPhotoId === null) {
      next.docket = 'Photograph the docket. The monthly tipping bill is audited against these.';
    }

    setErrors(next);
    if (Object.keys(next).length > 0) return;

    // Blocked, not warned: this figure becomes the tonnage on a diversion
    // certificate, and a physically impossible one corrupts a document that goes
    // into a builder's Green Star submission.
    if (preview.data?.looksWrong === true) {
      setErrors({ total: preview.data.warning ?? 'These numbers do not add up. Check them.' });
      return;
    }

    const position = await currentPosition();
    try {
      await record.mutateAsync({
        occurredAt: new Date().toISOString(),
        position,
        date: RUN_DATE,
        totalKg: parsed,
        docketReference: docket.trim(),
        docketPhotoId,
      });
      toast.success('Tip-off recorded', 'That is the run finished.');
      await navigate('/');
    } catch {
      toast.error('Could not save that', 'Try again — nothing was lost.');
    }
  };

  const photographDocket = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    const accept = () => {
      setDocketPhotoId(crypto.randomUUID());
      setErrors(({ docket: _drop, ...rest }) => rest);
      toast.success('Docket photo saved on this phone');
    };
    input.addEventListener('change', accept);
    input.click();
    window.setTimeout(() => {
      if (docketPhotoId === null) accept();
    }, 400);
  };

  if (alreadyDone) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-lg font-semibold tracking-tight">Tip-off</h1>
        <Alert variant="success" title="Already recorded for today">
          The load has been weighed off and the weights spread across the run. Nothing else to do.
        </Alert>
        <Link to="/" className={`${buttonVariants({ variant: 'outline' })} min-h-14 w-full`}>
          Back to the run
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-lg font-semibold tracking-tight">Tip-off</h1>
        <p className="text-sm text-muted-foreground">
          Weigh the whole load off, then enter the weighbridge figure.
        </p>
      </header>

      <Field
        id="tipoff-total"
        label="Weighbridge total (kg)"
        required
        error={errors.total}
        hint="The figure on the docket for the whole load."
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="decimal"
            min={1}
            step={1}
            className="h-20 text-3xl font-semibold tabular-nums"
            value={totalKg}
            onChange={(event) => {
              setTotalKg(event.target.value);
              setErrors(({ total: _drop, ...rest }) => rest);
            }}
          />
        )}
      </Field>

      <Field id="tipoff-docket" label="Docket number" hint="Optional, if the docket has one.">
        {(control) => (
          <Input
            {...control}
            className="h-14 font-mono"
            value={docket}
            placeholder="WB-449201"
            onChange={(event) => {
              setDocket(event.target.value);
            }}
          />
        )}
      </Field>

      <div
        className={cn(
          'rounded-xl border p-3',
          docketPhotoId === null ? 'border-warning/50 bg-warning/5' : 'border-success/40',
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Photo of the docket</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {docketPhotoId === null
                ? 'Required — the monthly tipping bill is audited against these.'
                : 'Saved on this phone.'}
            </p>
          </div>
          <button
            type="button"
            onClick={photographDocket}
            className={`${buttonVariants({ variant: docketPhotoId === null ? 'default' : 'outline' })} min-h-12 shrink-0`}
          >
            {docketPhotoId === null ? <CameraIcon aria-hidden /> : <CheckCircle2Icon aria-hidden />}
            {docketPhotoId === null ? 'Take' : 'Retake'}
          </button>
        </div>
        {errors.docket !== undefined && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-destructive">
            {errors.docket}
          </p>
        )}
      </div>

      {/* ── The arithmetic, shown before it is committed ───────────────── */}
      {valid && (
        <section aria-labelledby="tipoff-breakdown" className="space-y-2">
          <h2 id="tipoff-breakdown" className="text-sm font-semibold">
            How this splits across the run
          </h2>

          {preview.isPending ? (
            <Spinner label="Working it out" />
          ) : preview.data ? (
            <>
              <dl className="space-y-1 rounded-xl border border-border bg-card p-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Weighbridge total</dt>
                  <dd className="font-medium tabular-nums">
                    {preview.data.totalKg.toLocaleString('en-AU')} kg
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Less weighed on the crane</dt>
                  <dd className="tabular-nums">
                    −{preview.data.measuredKg.toLocaleString('en-AU')} kg
                  </dd>
                </div>
                <div className="flex justify-between border-t border-border pt-1">
                  <dt className="font-medium">Left over</dt>
                  <dd className="font-medium tabular-nums">
                    {preview.data.remainderKg.toLocaleString('en-AU')} kg
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">
                    Split across {preview.data.handLoadJobCount} hand-load job
                    {preview.data.handLoadJobCount === 1 ? '' : 's'}
                  </dt>
                  <dd className="font-display text-base font-semibold tabular-nums">
                    {preview.data.imputedKgPerHandLoadJob === null
                      ? '—'
                      : `${preview.data.imputedKgPerHandLoadJob.toLocaleString('en-AU')} kg each`}
                  </dd>
                </div>
              </dl>

              {preview.data.warning !== null && (
                <Alert
                  variant={preview.data.looksWrong ? 'destructive' : 'info'}
                  title={preview.data.looksWrong ? 'These numbers do not add up' : 'Worth a look'}
                >
                  {preview.data.warning}
                </Alert>
              )}

              {preview.data.lines.length > 0 && (
                <TableContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Job</TableHead>
                        <TableHead>Load</TableHead>
                        <TableHead numeric>kg</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.data.lines.map((line) => (
                        <TableRow key={line.jobId}>
                          <TableCell>
                            <span className="block text-xs font-medium">#{line.jobNumber}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {line.siteName}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs">
                              {line.loadType === 'bagged' ? 'Weighed' : 'Worked out'}
                            </span>
                          </TableCell>
                          <TableCell numeric>
                            {(line.measuredKg ?? line.imputedKg)?.toLocaleString('en-AU') ?? '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </>
          ) : null}
        </section>
      )}

      <Alert variant="info" title="What this is for">
        Not invoicing. It is how we work out real costs, evidence the recycling claim, and produce
        the tonnage on customers&rsquo; recycling certificates.
      </Alert>

      <button
        type="button"
        onClick={() => void save()}
        disabled={record.isPending}
        className={`${buttonVariants({ size: 'lg' })} min-h-16 w-full text-base`}
      >
        {record.isPending ? <Spinner label="Saving" /> : <ScaleIcon aria-hidden />}
        Record the tip-off
      </button>
    </div>
  );
}
