import {
  ACCOUNT_TYPES,
  AbnSchema,
  ACCOUNT_TYPE_DESCRIPTIONS,
  ACCOUNT_TYPE_LABELS,
  BRAND_LABELS,
  CAPTURE_MODES,
  CAPTURE_MODE_LABELS,
  PO_POLICIES,
  PO_POLICY_LABELS,
  type AccountType,
  type BrandId,
  type CaptureMode,
  type PoPolicy,
  type Zone,
} from '@plastago/shared';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
  useToast,
} from '@plastago/ui';
import { SproutIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { CONFIGURED_BRAND_IDS, IS_MULTI_BRAND } from '@/config/brands';
import { useRateCardOptions, useSelectableZones } from '@/features/lookups/queries';
import { useLeadConvert } from '@/features/queues/queries';
import { normaliseAbnInput } from '@/lib/format';
import { describeError } from '@/lib/error-message';
import { isServiceError } from '@/services/service-error';

/**
 * What the dialog needs to know about the lead it is converting.
 *
 * ── Why a structural shape and not `Lead` ─────────────────────────────────
 * A.4 is reachable from two places now: the lead's own page, which holds a full
 * `Lead`, and the leads grid, whose rows are `LeadListItem` and carry no notes
 * or attachments. Both satisfy these four fields, and demanding the richer type
 * would have meant fetching a whole lead to open a dialog that never reads it.
 */
/**
 * Form field → the label the person actually sees, and the input to focus.
 *
 * ── Why this table exists ─────────────────────────────────────────────────
 * A rejection has to name the field in the words on the screen. The API sends
 * `abn`, and a summary reading "abn: that is not a valid ABN" makes the reader
 * translate; it also has to be able to MOVE the cursor there, because the
 * dialog scrolls and the field at fault is frequently below the fold.
 *
 * Keyed by the field name the API uses, so a field the server objects to and
 * this table has never heard of still gets listed — under its raw name rather
 * than silently dropped.
 */
const FIELDS: Record<string, { label: string; inputId: string }> = {
  customerCode: { label: 'Customer code', inputId: 'convert-code' },
  abn: { label: 'ABN', inputId: 'convert-abn' },
  legalName: { label: 'Registered company name', inputId: 'convert-legal-name' },
  accountType: { label: 'Customer type', inputId: 'convert-account-type' },
  brandId: { label: 'Brand', inputId: 'convert-brand' },
  rateCardId: { label: 'Rate card', inputId: 'convert-rate-card' },
  poPolicy: { label: 'Purchase orders', inputId: 'convert-po-policy' },
  captureMode: { label: 'What the driver captures', inputId: 'convert-capture' },
  paymentTermsDays: { label: 'Payment terms', inputId: 'convert-terms' },
  primaryZoneId: { label: 'Primary zone', inputId: 'convert-zone' },
  accountsContactName: { label: 'Accounts contact', inputId: 'convert-contact-name' },
  accountsContactEmail: { label: 'Invoices emailed to', inputId: 'convert-contact-email' },
};

/** One rejected field, ready to list. */
interface Problem {
  field: string;
  label: string;
  message: string;
}

/** Why the last attempt did not create an account. */
interface Failure {
  /** The sentence at the top. Never a field message — those are listed below it. */
  headline: string;
  problems: readonly Problem[];
}

function toProblems(fieldErrors: Record<string, string>): Problem[] {
  return Object.entries(fieldErrors).map(([field, message]) => ({
    field,
    label: FIELDS[field]?.label ?? field,
    message,
  }));
}

/**
 * Put the cursor on the first field the attempt tripped over.
 *
 * The dialog body scrolls, so an error on "Payment terms" can be rejected
 * entirely off-screen — the summary says what is wrong and this says where.
 * Best-effort by design: a field that is not on screen is not worth throwing
 * over, and the summary has already done the important half.
 */
function focusField(field: string): void {
  const id = FIELDS[field]?.inputId;
  if (!id) return;

  const input = document.getElementById(id);
  if (!(input instanceof HTMLElement)) return;

  input.focus();
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export interface ConvertibleLead {
  id: string;
  companyName: string;
  contactName: string;
  /** Pre-fills the accounts contact, and is where the welcome email goes. */
  email: string;
  zoneId: Zone | null;
}

/* ── A.4 · Convert Lead → Account ─────────────────────────────────────────── */

interface ConvertForm {
  customerCode: string;
  legalName: string;
  abn: string;
  /** Empty until chosen — see `ConvertLeadDialog`. Never defaulted. */
  accountType: AccountType | '';
  brandId: BrandId;
  /*
   * A plain `string`, not `RateCardId | ''`.
   *
   * `RateCardId` used to be an enum, so the `| ''` carried real meaning — "not
   * one of the seven yet". It is a validated slug now, which `''` satisfies at
   * the type level, so the union said nothing. The requirement is unchanged
   * and still enforced: `submit` refuses an empty selection before it builds a
   * conversion, and the API refuses a card that does not exist.
   */
  rateCardId: string;
  poPolicy: PoPolicy;
  captureMode: CaptureMode;
  paymentTermsDays: string;
  primaryZoneId: Zone;
  accountsContactName: string;
  accountsContactEmail: string;
  notes: string;
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
export function ConvertLeadDialog({
  lead,
  open,
  onClose,
}: {
  lead: ConvertibleLead;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const convert = useLeadConvert();
  /*
   * M6.1 — the rate cards to choose from.
   *
   * The empty-string default on `rateCardId` below already forces a choice, so
   * an empty list while this loads means the form refuses to submit rather than
   * silently converting onto the wrong card.
   */
  const rateCards = useRateCardOptions().data ?? [];
  /*
   * The lead own zone is KEPT even if it has since been retired, so a lead
   * captured last month still converts without silently re-zoning the account.
   */
  const zones = useSelectableZones(lead.zoneId);

  const [form, setForm] = useState<ConvertForm>(() => ({
    // Three letters of the company name plus 001 is the pattern their existing
    // codes follow (IPL001, CLA001) — a suggestion, still editable.
    customerCode: `${lead.companyName
      .replace(/[^A-Za-z]/g, '')
      .slice(0, 3)
      .toUpperCase()}001`,
    legalName: lead.companyName,
    abn: '',
    accountType: '',
    brandId: 'plastago',
    rateCardId: '',
    poPolicy: 'not-required',
    captureMode: 'area-only',
    paymentTermsDays: '7',
    /*
     * ⚠️ Empty rather than a default zone.
     *
     * It fell back to Sydney, because a constant was lying around to fall back
     * to. The zone decides the service charge and the per-m² rate on every
     * invoice, so a silent default is a pricing incident that surfaces a month
     * later — the same argument this dialog already makes for the rate card.
     */
    primaryZoneId: lead.zoneId ?? '',
    /*
     * Pre-filled from the lead, and EDITABLE.
     *
     * The lead captured whoever rang. The person who handles the invoices is
     * frequently somebody else, and this is the last moment anybody looks before
     * the first invoice is raised — so it is shown rather than copied silently.
     */
    accountsContactName: lead.contactName,
    accountsContactEmail: lead.email,
    notes: '',
    sendInvitation: true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  /**
   * Why the last attempt failed, shown at the top of the dialog itself.
   *
   * Three surfaces carry the same rejection on purpose, because each one fails
   * on its own: the FIELD is where the fix happens but can be scrolled out of
   * sight, the SUMMARY here is always visible but not where you type, and the
   * TOAST survives even if the dialog is scrolled or the error names a field
   * this form does not have.
   */
  const [failure, setFailure] = useState<Failure | null>(null);

  const set = <TKey extends keyof ConvertForm>(key: TKey, value: ConvertForm[TKey]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Editing anything makes the last rejection stale — leaving it on screen
    // next to a changed form is how people re-read an error they have fixed.
    setFailure(null);
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
    /*
     * ⚠️ The SAME rule the API applies — `AbnSchema` carries the ATO checksum.
     *
     * Eleven digits was the whole client-side test, so a mistyped ABN passed
     * here and came back rejected by the server: a round trip to learn something
     * the browser already had the rule for. Reusing the shared schema also means
     * the two can never disagree about what a valid ABN is.
     */
    const abnDigits = form.abn.replace(/\s/g, '');
    const abnCheck = AbnSchema.safeParse(abnDigits);
    if (!abnCheck.success) {
      next.abn = `${abnCheck.error.issues[0]?.message ?? 'That ABN is not valid'}. Check it on ABN Lookup before creating the account.`;
    }
    if (!form.rateCardId) {
      next.rateCardId = 'Choose the rate card. Every invoice for this customer is priced from it.';
    }
    if (!form.accountType) {
      next.accountType =
        'Choose builder or contractor. It decides whether they get site supervisors and which booking form they see.';
    }
    if (!form.primaryZoneId) {
      next.primaryZoneId =
        'Choose the primary zone. The service charge and the per-m² rate both vary by zone.';
    }
    const terms = Number(form.paymentTermsDays);
    if (!Number.isInteger(terms) || terms < 0 || terms > 90) {
      next.paymentTermsDays = 'Whole days, 0 to 90. Their standard is 7.';
    }

    const contactName = form.accountsContactName.trim();
    const contactEmail = form.accountsContactEmail.trim();

    /*
     * ⚠️ The SAME three rules the API applies, so a correctable mistake does not
     * cost a round trip — and so the two can never disagree about what is valid.
     */
    if (contactEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      next.accountsContactEmail = 'Enter a valid email address, or leave it blank.';
    }
    if (contactEmail !== '' && contactName === '') {
      next.accountsContactName = 'Name the person that email belongs to.';
    }
    if (form.sendInvitation && contactEmail === '') {
      next.accountsContactEmail =
        'There is nowhere to send the welcome email. Add an address, or untick it below.';
    }

    setErrors(next);

    if (Object.keys(next).length > 0) {
      /*
       * A local failure gets the same three surfaces as a server rejection.
       * It used to get only the per-field red text, so pressing Create account
       * with a bad field below the fold looked identical to pressing it with
       * nothing wrong at all: nothing moved.
       */
      const problems = toProblems(next);
      setFailure({
        headline: 'Some details need correcting before this can be saved.',
        problems,
      });
      toast.error('The account was not created', problems[0]?.message);
      if (problems[0]) focusField(problems[0].field);
      return;
    }

    setFailure(null);

    try {
      const result = await convert.mutateAsync({
        id: lead.id,
        input: {
          customerCode: form.customerCode,
          legalName: form.legalName.trim(),
          abn: abnDigits,
          accountType: form.accountType as AccountType,
          brandId: form.brandId,
          rateCardId: form.rateCardId,
          poPolicy: form.poPolicy,
          captureMode: form.captureMode,
          paymentTermsDays: terms,
          primaryZoneId: form.primaryZoneId,
          accountsContactName: contactName,
          accountsContactEmail: contactEmail,
          notes: form.notes.trim(),
          sendInvitation: form.sendInvitation,
        },
      });

      /*
       * ⚠️ What the send ACTUALLY did, never what was asked for. A cheerful
       * "on its way" over a provider that refused the message is how a customer
       * ends up waiting for an email nobody knows never left.
       */
      if (result.welcome === null) {
        toast.success(
          `${form.legalName.trim()} created as ${result.customerCode}`,
          'No invitation was sent — you can send one from the account.',
        );
      } else if (result.welcome.outcome === 'sent' || result.welcome.outcome === 'duplicate') {
        toast.success(
          `${form.legalName.trim()} created as ${result.customerCode}`,
          `Sign-in link emailed to ${result.welcome.toMasked ?? 'their accounts contact'}.`,
        );
      } else {
        toast.warning(
          `${form.legalName.trim()} created as ${result.customerCode}, but the welcome email did not send`,
          `${result.welcome.detail ?? 'The email did not go out'} — give them their customer code by phone; they can sign in as soon as they have it.`,
        );
      }
      onClose();
      /*
       * ⚠️ The ACCOUNT, not back to the leads list.
       *
       * Converting stamps the lead with its new account and the grid hides
       * anything so stamped — so returning to the list dropped you on the one
       * screen guaranteed not to show what you had just made. It read as the
       * lead having been deleted.
       */
      await navigate(`/admin/customers/${result.accountId}`);
    } catch (caught) {
      /*
       * ⚠️ Errors from here must be shown INSIDE the dialog.
       *
       * Two things hid them. The server's field `issues` were dropped on the
       * floor, so "Customer code TES001 is already in use" never reached the
       * box it was about; and this dialog is a native <dialog> opened with
       * `showModal()`, which puts it in the browser's top layer — above every
       * z-index there is, including the toast viewport. So the one signal left
       * was painted behind the thing it was reporting on, and pressing Create
       * account looked like it did nothing at all.
       */
      const described = describeError(caught);
      const fieldErrors = isServiceError(caught) ? caught.fieldErrors : {};
      const problems = toProblems(fieldErrors);

      setErrors(fieldErrors);
      setFailure({
        /*
         * When the server named fields, the headline must not repeat their
         * messages — "Request validation failed" says nothing the list below it
         * does not say better. When it named none, the generic copy IS the whole
         * message and has to carry it.
         */
        headline:
          problems.length > 0
            ? 'Some details need correcting before this can be saved.'
            : described.detail
              ? `${described.title} — ${described.detail}`
              : described.title,
        problems,
      });

      // The toast carries the first real reason rather than the generic
      // envelope: it is the surface that survives a scrolled dialog.
      toast.error(
        'The account was not created',
        problems[0]?.message ?? described.detail ?? described.title,
      );

      if (problems[0]) focusField(problems[0].field);
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
        {failure && (
          <Alert variant="destructive" title="The account was not created">
            <p>{failure.headline}</p>
            {failure.problems.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {failure.problems.map((problem) => (
                  <li key={problem.field}>
                    {/*
                      The label is a button, not text. The field it names is
                      often scrolled out of view, and a "Payment terms" that
                      jumps you to Payment terms is the shortest path from
                      reading the problem to fixing it.
                    */}
                    <button
                      type="button"
                      className="focus-ring rounded font-medium underline underline-offset-4"
                      onClick={() => {
                        focusField(problem.field);
                      }}
                    >
                      {problem.label}
                    </button>
                    {' — '}
                    {problem.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        <section className="space-y-4">
          <h3 className="text-sm font-semibold">Identity</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    /*
                     * Six characters, letters and digits only — the shape the
                     * validator below demands (AAA000). Same reasoning as the
                     * ABN: the field should not be able to hold a code that
                     * cannot exist, and stripping punctuation means a pasted
                     * "BEL-001" arrives as BEL001 rather than as an error.
                     */
                    set(
                      'customerCode',
                      event.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, '')
                        .slice(0, 6),
                    );
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
                    // Digits only, capped at eleven. See `normaliseAbnInput`.
                    set('abn', normaliseAbnInput(event.target.value));
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

          {/*
            Opens empty, exactly like the rate card and for the same reason.

            Builder or contractor decides whether the customer gets site
            supervisors and whether their booking form asks for the area and bag
            count (Matt, 21:55). Conversion used to write `builder` for every
            lead without asking, so a contractor got supervisors they never use
            and a short form missing the only figures they can give us.
          */}
          <Field
            id="convert-account-type"
            label="Customer type"
            required
            error={errors.accountType}
            hint={
              form.accountType
                ? ACCOUNT_TYPE_DESCRIPTIONS[form.accountType]
                : 'Decides site supervisors and which booking form they get.'
            }
          >
            {(control) => (
              <Select
                {...control}
                value={form.accountType}
                onChange={(event) => {
                  set('accountType', event.target.value as AccountType);
                }}
              >
                <option value="">Choose builder or contractor…</option>
                {ACCOUNT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ACCOUNT_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* One configured brand is not a choice, so the form submits its default. */}
          {IS_MULTI_BRAND && (
            <Field id="convert-brand" label="Brand" hint="Which brand services them.">
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
            hint="Resolution order is named card → tier → default."
          >
            {(control) => (
              <Select
                {...control}
                value={form.rateCardId}
                onChange={(event) => {
                  set('rateCardId', event.target.value);
                }}
              >
                <option value="">Choose a rate card…</option>
                {/*
                  Loaded (M6.1). Conversion is where a lead's rates are agreed,
                  so it has to offer the card that was negotiated — including
                  one an administrator created for this builder an hour ago.
                */}
                {rateCards.map((card) => (
                  <option key={card.value} value={card.value}>
                    {card.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              hint="Service charge and per-m² rate both vary by zone."
            >
              {(control) => (
                <Select
                  {...control}
                  value={form.primaryZoneId}
                  onChange={(event) => {
                    set('primaryZoneId', event.target.value);
                  }}
                >
                  <option value="">Choose a zone…</option>
                  {zones.map((zone) => (
                    <option key={zone.value} value={zone.value}>
                      {zone.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Accounts contact</h3>
            <p className="text-xs text-muted-foreground">
              Where their invoices and recycling certificates go. Taken from the lead — change it if
              somebody else handles their accounts.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="convert-contact-name"
              label="Who handles their invoices"
              error={errors.accountsContactName}
            >
              {(control) => (
                <Input
                  {...control}
                  value={form.accountsContactName}
                  placeholder="Marcus Webb"
                  onChange={(event) => {
                    set('accountsContactName', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id="convert-contact-email"
              label="Invoices emailed to"
              error={errors.accountsContactEmail}
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  inputMode="email"
                  value={form.accountsContactEmail}
                  placeholder="ap@company.com.au"
                  onChange={(event) => {
                    set('accountsContactEmail', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field
            id="convert-notes"
            label="Notes"
            error={errors.notes}
            hint="Kept on the account, under the line recording which lead it came from."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={form.notes}
                placeholder="Anything the office should know about this account."
                onChange={(event) => {
                  set('notes', event.target.value);
                }}
              />
            )}
          </Field>
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
              {form.accountsContactName.trim() || lead.contactName} gets their customer code and a
              sign-in link, at {form.accountsContactEmail.trim() || lead.email}. Uncheck if you want
              to set the account up quietly first.
            </p>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/* ── Attachments (Matt, 5:53) ────────────────────────────────────────────── */
