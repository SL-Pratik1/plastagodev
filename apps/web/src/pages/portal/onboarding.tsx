import { TermsSigningSchema } from '@plastago/shared';
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
  useToast,
} from '@plastago/ui';
import { CheckCircle2Icon, FileTextIcon, PenLineIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '@/components/page-header';
import { SignaturePad } from '@/components/portal/signature-pad';
import { useDocumentTab } from '@/features/documents/use-document-tab';
import { usePortalScope } from '@/features/portal/queries';
import { usePortalTermsStatus, useSignTerms } from '@/features/terms/queries';
import { describeError } from '@/lib/error-message';
import { formatDate } from '@/lib/format';
import { useServices } from '@/services/services-context';

/**
 * Before using the portal: details, the director's guarantee, read, sign.
 *
 * Matt, 21 Oct: *"we have a form now they fill out, like a credit terms and
 * directors guarantee… So they filled out all those details the first time
 * they logged on."* And: *"them having to sign it, and record… their agreeance
 * and the IP address that they used to agree."*
 *
 * Asked of a customer administrator on an account opened with the onboarding
 * tick, and again when a newer version of the terms is uploaded. The server
 * records the time, the IP and the browser — nothing about that is asked here.
 */
export function PortalOnboardingPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const openTab = useDocumentTab();
  const { terms } = useServices();
  const scope = usePortalScope();
  const status = usePortalTermsStatus();
  const sign = useSignTerms();

  const [directorName, setDirectorName] = useState<string | null>(null);
  const [directorAddress, setDirectorAddress] = useState<string | null>(null);
  const [directorSignature, setDirectorSignature] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [hasRead, setHasRead] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (status.error) {
    const described = describeError(status.error);
    return (
      <Card>
        <ErrorState
          title={described.title}
          description={described.detail}
          onRetry={() => void status.refetch()}
        />
      </Card>
    );
  }

  if (status.isPending) {
    return (
      <Card className="p-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-4 h-64 w-full" />
      </Card>
    );
  }

  const { data } = status;
  const current = data.current;

  // Nothing to do — signed already, or never asked. Not a dead end.
  if (!data.required || current === null) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeader title="Terms and conditions" />
        <Alert variant="success" title="Nothing to sign">
          {data.signedVersion === null
            ? 'Your account does not need to sign the terms online.'
            : `Your account signed version ${String(data.signedVersion)} of the terms.`}
        </Alert>
        <Link to="/portal" className="text-sm font-medium text-primary underline underline-offset-4">
          Go to the portal
        </Link>
      </div>
    );
  }

  // Pre-filled from the last signing when a newer version asks again.
  const director = {
    name: directorName ?? data.lastDirector?.name ?? '',
    address: directorAddress ?? data.lastDirector?.address ?? '',
  };

  const readTerms = async () => {
    // Reserved before the await — see `useDocumentTab`.
    const deliver = openTab();
    try {
      const document = await terms.currentDocument();
      deliver(document.url);
      setOpened(true);
      setErrors(({ hasReadTerms: _drop, ...rest }) => rest);
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const submit = async () => {
    const parsed = TermsSigningSchema.safeParse({
      version: current.version,
      directorName: director.name,
      directorAddress: director.address,
      directorSignature: directorSignature ?? undefined,
      signerName,
      signature: signature ?? undefined,
      hasReadTerms: hasRead ? true : undefined,
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = String(issue.path[0] ?? 'form');
        next[path] ??= issue.message;
      }
      setErrors(next);
      toast.error('A few things are still needed', Object.values(next)[0]);
      return;
    }

    try {
      await sign.mutateAsync(parsed.data);
      toast.success('Thank you — the terms are signed', 'Your account is ready to use.');
      await navigate('/portal', { replace: true });
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
      // A newer version went up meanwhile — show it.
      void status.refetch();
    }
  };

  const signedBefore = data.signedVersion !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title={signedBefore ? 'Our terms have been updated' : 'Before you start'}
        description={`${scope.data?.accountName ?? 'Your account'} · ${
          signedBefore
            ? `version ${String(current.version)} replaces the version you signed`
            : 'four steps, once'
        }`}
      />

      {/* ── 1 · Company details ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>1. Your company details</CardTitle>
          {data.detailsCompleted && <Badge variant="success">Done</Badge>}
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Registered name, ABN, address and where invoices and certificates go.
          </p>
          <Link
            to="/portal/welcome"
            className="inline-flex text-sm font-medium text-primary underline underline-offset-4"
          >
            {data.detailsCompleted ? 'Review your details' : 'Fill in your company details'}
          </Link>
        </CardContent>
      </Card>

      {!data.detailsCompleted && (
        <Alert variant="info" title="Start with step 1">
          The guarantee and the terms are signed once your company details are in.
        </Alert>
      )}

      {/* ── 2 · Director's guarantee ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>2. Director’s guarantee</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            A director of the company guarantees the account, as set out in the terms and conditions
            below.
          </p>
          <Field
            id="onb-director-name"
            label="Director’s full name"
            required
            error={errors.directorName}
          >
            {(control) => (
              <Input
                {...control}
                value={director.name}
                autoComplete="name"
                onChange={(event) => {
                  setDirectorName(event.target.value);
                }}
              />
            )}
          </Field>
          <Field
            id="onb-director-address"
            label="Director’s residential address"
            required
            error={errors.directorAddress}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                value={director.address}
                autoComplete="street-address"
                onChange={(event) => {
                  setDirectorAddress(event.target.value);
                }}
              />
            )}
          </Field>
          <SignaturePad
            id="onb-director-signature"
            label="Director’s signature"
            error={errors.directorSignature}
            onChange={setDirectorSignature}
          />
        </CardContent>
      </Card>

      {/* ── 3 · Read the terms ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle>3. Read the terms and conditions</CardTitle>
          {opened && <Badge variant="success">Opened</Badge>}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {current.fileName} · version {current.version} · {formatDate(current.uploadedAt)}
          </p>
          <Button type="button" variant="outline" onClick={() => void readTerms()}>
            <FileTextIcon aria-hidden />
            Open the terms (PDF)
          </Button>
          <div className="flex items-start gap-3">
            <Checkbox
              id="onb-has-read"
              checked={hasRead}
              disabled={!opened}
              aria-invalid={errors.hasReadTerms !== undefined}
              onChange={(event) => {
                setHasRead(event.target.checked);
                setErrors(({ hasReadTerms: _drop, ...rest }) => rest);
              }}
            />
            <div>
              <Label htmlFor="onb-has-read" className="font-normal">
                I have read and agree to the terms and conditions
              </Label>
              {!opened && (
                <p className="text-xs text-muted-foreground">Open the terms first.</p>
              )}
              {errors.hasReadTerms !== undefined && (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {errors.hasReadTerms}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 4 · Sign ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>4. Sign</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="onb-signer-name" label="Your full name" required error={errors.signerName}>
            {(control) => (
              <Input
                {...control}
                value={signerName}
                autoComplete="name"
                onChange={(event) => {
                  setSignerName(event.target.value);
                }}
              />
            )}
          </Field>
          <SignaturePad
            id="onb-signature"
            label="Your signature"
            error={errors.signature}
            onChange={setSignature}
          />
          <p className="text-xs text-muted-foreground">
            We record your name, both signatures, the time, your IP address and browser, and the
            version of the terms. You can ask us for a copy at any time.
          </p>
          <Button
            type="button"
            className="w-full sm:w-auto"
            disabled={sign.isPending || !data.detailsCompleted}
            onClick={() => void submit()}
          >
            {sign.isPending ? <Spinner label="Signing" /> : <PenLineIcon aria-hidden />}
            Sign and continue
          </Button>
          {sign.isSuccess && (
            <p className="flex items-center gap-1.5 text-sm text-success">
              <CheckCircle2Icon aria-hidden className="size-4" />
              Signed
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
