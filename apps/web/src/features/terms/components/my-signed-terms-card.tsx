import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton, useToast } from '@plastago/ui';
import { DownloadIcon } from 'lucide-react';
import { useDocumentTab } from '@/features/documents/use-document-tab';
import { describeError } from '@/lib/error-message';
import { formatDateTime } from '@/lib/format';
import { useServices } from '@/services/services-context';
import { usePortalTermsStatus } from '../queries';

/**
 * The customer's own signed terms, on their Account page (23 Oct).
 *
 * Only their account's signing — the server reads the account from the
 * session, so there is no id here for anyone to change. The copy is the same
 * document the office downloads: the terms with the signing page appended.
 */
export function MySignedTermsCard() {
  const toast = useToast();
  const openTab = useDocumentTab();
  const { terms } = useServices();
  const status = usePortalTermsStatus();

  const download = async () => {
    // Reserved before the await — see `useDocumentTab`.
    const deliver = openTab();
    try {
      deliver(await terms.mySignedCopyUrl());
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Terms and conditions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {status.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : status.error ? (
          <p className="text-muted-foreground">
            We could not load your signed terms just now. Reload to try again.
          </p>
        ) : status.data.signed ? (
          <>
            <p>
              Signed on <strong>{formatDateTime(status.data.signed.signedAt)}</strong> by{' '}
              <strong>{status.data.signed.signerName}</strong> · version{' '}
              {status.data.signed.version}
            </p>
            <Button variant="outline" size="sm" onClick={() => void download()}>
              <DownloadIcon aria-hidden />
              Download your signed copy
            </Button>
          </>
        ) : (
          <p className="text-muted-foreground">
            Your account has not signed terms online. Your agreement with PlastaGo covers them —
            call the office on 1300 395 438 for a copy.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
