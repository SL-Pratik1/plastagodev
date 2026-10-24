import {
  CAPTURE_MODES,
  CAPTURE_MODE_LABELS,
  PO_POLICIES,
  PO_POLICY_LABELS,
  type Account,
  type CaptureMode,
  type PoPolicy,
} from '@plastago/shared';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Spinner, useToast } from '@plastago/ui';
import { useState } from 'react';
import { useCommercialTermsImpact, useSetCommercialTerms } from '@/features/customers/queries';
import { useRateCardOptions } from '@/features/lookups/queries';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';

/**
 * Change a customer's rate card and commercial terms.
 *
 * Matt, 21 Oct: *"there's currently no way to change the rate card that
 * they're on… commercial terms, the rate card, payment terms, all of that."*
 *
 * ── What it says before saving ───────────────────────────────────────────
 * Two things move besides the account, and the office should see both before
 * pressing Save rather than discover them afterwards:
 *
 *  • open jobs keep their booked price unless "Update their price too" is
 *    ticked — offered only when the rate card is actually changing;
 *  • switching "PO required" off releases their invoices waiting for a PO.
 *
 * The parent remounts this on every open (`key`), so the form always starts
 * from what is stored.
 */
export function CommercialTermsDialog({
  account,
  open,
  onClose,
}: {
  account: Account;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const rateCards = useRateCardOptions();
  const impact = useCommercialTermsImpact(account.id, open);
  const save = useSetCommercialTerms(account.id);

  const [rateCardId, setRateCardId] = useState(account.rateCardId);
  const [paymentTermsDays, setPaymentTermsDays] = useState(String(account.paymentTermsDays));
  const [poPolicy, setPoPolicy] = useState<PoPolicy>(account.poPolicy);
  const [captureMode, setCaptureMode] = useState<CaptureMode>(account.captureMode);
  const [repriceOpenJobs, setRepriceOpenJobs] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const cardChanging = rateCardId !== account.rateCardId;
  const releasingPo =
    account.poPolicy === 'required-before-invoice' && poPolicy !== 'required-before-invoice';
  const openJobs = impact.data?.openJobs ?? 0;
  const awaitingPo = impact.data?.awaitingPoInvoices ?? 0;

  const unchanged =
    !cardChanging &&
    paymentTermsDays.trim() === String(account.paymentTermsDays) &&
    poPolicy === account.poPolicy &&
    captureMode === account.captureMode;

  const submit = async () => {
    const days = Number(paymentTermsDays);
    if (paymentTermsDays.trim() === '' || !Number.isInteger(days) || days < 0 || days > 90) {
      setErrors({ paymentTermsDays: 'Enter whole days from 0 to 90' });
      return;
    }
    setErrors({});

    try {
      const result = await save.mutateAsync({
        rateCardId,
        paymentTermsDays: days,
        poPolicy,
        captureMode,
        repriceOpenJobs: cardChanging && repriceOpenJobs,
      });

      const cardLabel =
        rateCards.data?.find((card) => card.value === result.account.rateCardId)?.label ??
        result.account.rateCardId;
      const notes = [
        `Rate card: ${cardLabel}.`,
        result.repricedJobs > 0 &&
          `${String(result.repricedJobs)} open job${result.repricedJobs === 1 ? '' : 's'} re-priced.`,
        result.releasedInvoices > 0 &&
          `${String(result.releasedInvoices)} invoice${result.releasedInvoices === 1 ? '' : 's'} released from Awaiting PO.`,
      ].filter(Boolean);
      toast.success('Commercial terms saved', notes.join(' '));

      // A job the new card could not price keeps its old price — said, not hidden.
      if (result.notRepriced.length > 0) {
        toast.warning(
          `${String(result.notRepriced.length)} job${result.notRepriced.length === 1 ? '' : 's'} kept the old price`,
          result.notRepriced.map((job) => `#${String(job.jobNumber)}: ${job.reason}`).join(' · '),
        );
      }
      onClose();
    } catch (caught) {
      if (isServiceError(caught) && Object.keys(caught.fieldErrors).length > 0) {
        setErrors(caught.fieldErrors);
        return;
      }
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Commercial terms"
      description={`What ${account.name} is charged and how they are invoiced.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={save.isPending || unchanged}>
            {save.isPending && <Spinner label="Saving" />}
            Save terms
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="ct-rate-card"
            label="Rate card"
            required
            error={errors.rateCardId}
            hint="Every new booking for this customer is priced from it."
          >
            {(aria) => (
              <Select
                {...aria}
                value={rateCardId}
                disabled={rateCards.isPending}
                onChange={(event) => {
                  setRateCardId(event.target.value);
                }}
              >
                {/* The current card stays listed even if the lookup does not hold it. */}
                {!rateCards.data?.some((card) => card.value === account.rateCardId) && (
                  <option value={account.rateCardId}>{account.rateCardId}</option>
                )}
                {(rateCards.data ?? []).map((card) => (
                  <option key={card.value} value={card.value}>
                    {card.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            id="ct-terms"
            label="Payment terms"
            required
            error={errors.paymentTermsDays}
            hint="Days. Their standard is 7."
          >
            {(aria) => (
              <Input
                {...aria}
                type="number"
                inputMode="numeric"
                min={0}
                max={90}
                value={paymentTermsDays}
                onChange={(event) => {
                  setPaymentTermsDays(event.target.value);
                }}
              />
            )}
          </Field>

          <Field id="ct-po" label="PO policy" required error={errors.poPolicy}>
            {(aria) => (
              <Select
                {...aria}
                value={poPolicy}
                onChange={(event) => {
                  setPoPolicy(event.target.value as PoPolicy);
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
            id="ct-capture"
            label="What we record"
            required
            error={errors.captureMode}
            hint="Weight is needed for recycling certificates."
          >
            {(aria) => (
              <Select
                {...aria}
                value={captureMode}
                onChange={(event) => {
                  setCaptureMode(event.target.value as CaptureMode);
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
        </div>

        {impact.isPending ? (
          <Spinner label="Checking their open jobs" />
        ) : impact.error ? (
          <Alert variant="warning" title="Could not check their open jobs">
            You can still save. Open jobs keep the price they were booked at.
          </Alert>
        ) : (
          <>
            {cardChanging &&
              (openJobs > 0 ? (
                <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={repriceOpenJobs}
                    onChange={(event) => {
                      setRepriceOpenJobs(event.target.checked);
                    }}
                  />
                  <span>
                    <span className="block font-medium">Update their price too</span>
                    <span className="block text-xs text-muted-foreground">
                      {openJobs} open job{openJobs === 1 ? '' : 's'} with no invoice yet. Left
                      unticked, {openJobs === 1 ? 'it keeps' : 'they keep'} the price{' '}
                      {openJobs === 1 ? 'it was' : 'they were'} booked at. Invoiced work never
                      changes.
                    </span>
                  </span>
                </label>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No open jobs to re-price — the new rate card applies from their next booking.
                </p>
              ))}

            {releasingPo && awaitingPo > 0 && (
              <Alert variant="info" title="Invoices waiting for a PO will be released">
                {awaitingPo} invoice{awaitingPo === 1 ? '' : 's'} in Awaiting PO will move to
                Draft, ready to send.
              </Alert>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
