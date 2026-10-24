import type { Account } from '@plastago/shared';
import { Button, useToast } from '@plastago/ui';
import { DownloadIcon } from 'lucide-react';
import { useDocumentTab } from '@/features/documents/use-document-tab';
import { describeError } from '@/lib/error-message';
import { formatDateTime } from '@/lib/format';
import { useServices } from '@/services/services-context';

/**
 * Where a customer is with the terms, for the customer page (Matt, 21 Oct).
 *
 * Wendell: *"they signed it on this particular date. Here's the actual
 * signature… time stamp… IP address… proof that they signed up."* So: signed on,
 * by, from which IP — and a download of the terms with the signing page.
 */
export function TermsSignatureLine({ account }: { account: Account }) {
  const toast = useToast();
  const openTab = useDocumentTab();
  const { terms } = useServices();
  const signature = account.termsSignature;

  const download = async () => {
    // Reserved before the await — see `useDocumentTab`.
    const deliver = openTab();
    try {
      deliver(await terms.signedCopyUrl(account.id));
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <span className="flex flex-col items-start gap-1.5">
      {signature !== null && (
        <span>
          Signed on {formatDateTime(signature.signedAt)} by {signature.signerName}
          {signature.ip ? ` (IP ${signature.ip})` : ''} · version {signature.version}
        </span>
      )}
      {account.termsPending ? (
        <span className="text-warning">
          {signature === null
            ? 'Waiting for them to sign on their first sign-in'
            : 'A newer version is waiting for them to sign'}
        </span>
      ) : !account.termsRequired && signature === null ? (
        <span className="text-muted-foreground">Not asked — covered by a signed contract</span>
      ) : null}
      {signature !== null && (
        <Button variant="outline" size="sm" onClick={() => void download()}>
          <DownloadIcon aria-hidden />
          Download what they signed
        </Button>
      )}
    </span>
  );
}
