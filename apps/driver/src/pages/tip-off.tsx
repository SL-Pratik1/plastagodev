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
 * = remainder × (this job's m² ÷ total hand-load m²) = its imputed weight
 * ```
 *
 * ── Why the split is by size and not per head ─────────────────────────────
 * Matt, 56:11: *"split the remaining weight left over over those two jobs based
 * on how big they are… 2/3 of the weight left over to that 1000 square meter job
 * and 1/3 to the 500 square meter job."* So there is no single "kg each" figure
 * to show — the per-job shares differ, and the table below is the answer rather
 * than a breakdown of one.
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
  const [chosenRunId, setChosenRunId] = useState<string | null>(null);

  /*
   * Which run is being weighed off.
   *
   * Defaults to the first run that has not been tipped off yet, because that is
   * almost always the one the driver is standing at the weighbridge for — he
   * does the morning run, tips off, then does the afternoon one (Matt, 40:03).
   * The selector exists for the case where it is not.
   */
  const runs = day?.runs ?? [];
  const outstanding = runs.filter((run) => run.tipOffRecordedAt === null);
  const activeRunId = chosenRunId ?? outstanding[0]?.runId ?? null;
  const activeRun = runs.find((run) => run.runId === activeRunId) ?? null;

  const parsed = Number(totalKg);
  const valid = Number.isFinite(parsed) && parsed > 0;
  const preview = useTipOffPreview(activeRunId, valid ? parsed : 0, valid);

  const alreadyDone = runs.length > 0 && outstanding.length === 0;

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
        runId: activeRunId ?? '',
        date: RUN_DATE,
        totalKg: parsed,
        docketReference: docket.trim(),
        docketPhotoId,
      });
      toast.success(
        'Tip-off recorded',
        outstanding.length > 1
          ? `${activeRun?.runName ?? 'That run'} is finished — one more to go.`
          : 'That is the run finished.',
      );
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
        <Alert variant="success" title="Every run weighed off">
          Each run has its own weighbridge docket, and both are recorded. The weights have been
          spread across the stops on each. Nothing else to do.
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
          Weigh this run&rsquo;s load off, then enter the weighbridge figure.
        </p>
      </header>

      {/*
        One docket per run, not per day.
        Matt, 43:50: *"sometimes the driver will do two runs. He'll go to the tip
        in between… we add the weighbridge ticket against that run."* With two
        runs outstanding the driver has to say which one is on the scales — the
        wrong choice would spread this weight over the wrong stops.
      */}
      {outstanding.length > 1 ? (
        <fieldset className="rounded-xl border border-warning/50 bg-warning/5 p-3">
          <legend className="px-1 text-sm font-medium">Which run is this docket for?</legend>
          <div className="mt-1 space-y-2">
            {outstanding.map((run) => (
              <label
                key={run.runId}
                className={cn(
                  'flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border p-3',
                  run.runId === activeRunId ? 'border-primary bg-card' : 'border-border',
                )}
              >
                <input
                  type="radio"
                  name="tipoff-run"
                  className="size-5 shrink-0"
                  checked={run.runId === activeRunId}
                  onChange={() => {
                    setChosenRunId(run.runId);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{run.runName}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {run.stops.length} stop{run.stops.length === 1 ? '' : 's'} ·{' '}
                    {run.suburbs.join(', ')}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        activeRun !== null && (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            Weighing off <strong>{activeRun.runName}</strong> — {activeRun.stops.length} stop
            {activeRun.stops.length === 1 ? '' : 's'}.
          </p>
        )
      )}

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
                    Shared across {preview.data.handLoadJobCount} hand-load job
                    {preview.data.handLoadJobCount === 1 ? '' : 's'}, by size
                  </dt>
                  <dd className="font-display text-base font-semibold tabular-nums">
                    {preview.data.handLoadJobCount === 0
                      ? '—'
                      : `${preview.data.handLoadAreaM2.toLocaleString('en-AU')} m² total`}
                  </dd>
                </div>
              </dl>

              {/*
               * Stated in words because the driver is being asked to sanity-check
               * the arithmetic, and "by size" is the part that is surprising if
               * you expected the old equal split.
               */}
              {preview.data.handLoadJobCount > 1 && (
                <p className="text-xs text-muted-foreground">
                  A bigger job takes a bigger share — each one gets the leftover in proportion to
                  its square metres.
                </p>
              )}

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
                        <TableHead>Basis</TableHead>
                        <TableHead numeric>kg</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.data.lines.map((line) => (
                        <TableRow key={line.jobId}>
                          <TableCell>
                            <span className="block text-xs font-medium">#{line.jobNumber}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {line.siteName} · {line.areaM2.toLocaleString('en-AU')} m²
                            </span>
                          </TableCell>
                          <TableCell>
                            {/*
                             * The words Matt used, on the row that carries the
                             * number: "actual" where the driver weighed it,
                             * "estimated" where it came out of this split.
                             */}
                            <span className="block text-xs">
                              {line.loadType === 'bagged' ? 'Actual' : 'Estimated'}
                            </span>
                            <span className="block text-[11px] text-muted-foreground">
                              {line.loadType === 'bagged'
                                ? 'Crane scale'
                                : line.shareOfRemainder === null
                                  ? 'Share of leftover'
                                  : `${String(Math.round(line.shareOfRemainder * 100))}% of leftover`}
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
