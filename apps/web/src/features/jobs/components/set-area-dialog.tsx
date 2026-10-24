import { hasAtMostTwoDecimals } from '@plastago/shared';
import { Button, Dialog, Field, Input, useToast } from '@plastago/ui';
import { useState } from 'react';
import { describeError } from '@/lib/error-message';
import { formatInvoiceNumber, formatMoney } from '@/lib/format';
import { isServiceError } from '@/services/service-error';
import { useSetJobArea } from '../queries';

/** Why a typed figure cannot be saved, or null. The server holds the same rules. */
function areaProblem(raw: string): string | null {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) return 'Enter the m² — more than 0';
  if (value > 100000) return 'That looks too large — check the figure';
  if (!hasAtMostTwoDecimals(value)) return 'Use at most two decimal places, e.g. 972.62';
  return null;
}

/**
 * "Set m²" (23 Oct) — the area a purchase order left out.
 *
 * A job priced per m² cannot be invoiced without it, and used to be invoiced
 * without its m² charge at all. Saving re-prices the job; a completed job that
 * was waiting only for this is invoiced and emailed straight away, and the
 * message says so.
 */
export function SetAreaDialog({
  job,
  invoicePrefix,
  open,
  onClose,
}: {
  job: { id: string; jobNumber: number; areaPriced: boolean };
  invoicePrefix: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const setArea = useSetJobArea();
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setRaw('');
    setError(null);
    onClose();
  };

  const save = async () => {
    const problem = areaProblem(raw);
    if (problem) {
      setError(problem);
      return;
    }

    try {
      const result = await setArea.mutateAsync({ id: job.id, expectedAreaM2: Number(raw) });
      const invoiced = result.invoiced.map((number) => formatInvoiceNumber(number, invoicePrefix));
      toast.success(
        `m² set on job #${String(job.jobNumber)}`,
        invoiced.length > 0
          ? `Priced at ${formatMoney(result.totalExGst)} ex GST. Invoice ${invoiced.join(', ')} was raised and emailed.`
          : result.held.length > 0
            ? `Priced at ${formatMoney(result.totalExGst)} ex GST. Still not invoiced — missing ${result.held.join(', ')}.`
            : `Priced at ${formatMoney(result.totalExGst)} ex GST.`,
      );
      close();
    } catch (caught) {
      if (isServiceError(caught) && caught.fieldErrors.expectedAreaM2) {
        setError(caught.fieldErrors.expectedAreaM2);
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`Set the m² on job #${String(job.jobNumber)}`}
      description={
        job.areaPriced
          ? 'This customer is charged per m², so the job is re-priced from it. Its invoice waits for it.'
          : 'This job has a fixed price, so the m² is kept for the record and does not change the price.'
      }
      footer={
        <>
          <Button variant="outline" onClick={close} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={setArea.isPending}
            className="w-full sm:w-auto"
          >
            {setArea.isPending ? 'Saving…' : 'Save m²'}
          </Button>
        </>
      }
    >
      <div className="py-2">
        <Field
          id="set-area"
          label="m²"
          required
          error={error ?? undefined}
          hint="The exact figure from the builder, e.g. 972.62."
        >
          {(aria) => (
            <Input
              {...aria}
              type="number"
              inputMode="decimal"
              min={0.01}
              step={0.01}
              placeholder="972.62"
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
