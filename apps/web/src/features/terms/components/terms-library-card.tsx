import type { TermsDocument } from '@plastago/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Skeleton,
  Spinner,
  useToast,
} from '@plastago/ui';
import { FileTextIcon, UploadIcon } from 'lucide-react';
import { useRef } from 'react';
import { useDocumentTab } from '@/features/documents/use-document-tab';
import { describeError } from '@/lib/error-message';
import { formatDateTime } from '@/lib/format';
import { useServices } from '@/services/services-context';
import { useTermsLibrary, useUploadTerms } from '../queries';

/**
 * The terms and conditions customers sign (Matt, 21 Oct).
 *
 * *"I need a place where I can upload those terms."* Every upload is a new
 * version — nothing is replaced, because a customer's signature points at the
 * exact document they read — and a new version asks the customers who sign
 * online to sign again on their next sign-in.
 */
export function TermsLibraryCard() {
  const toast = useToast();
  const openTab = useDocumentTab();
  const { terms } = useServices();
  const library = useTermsLibrary();
  const upload = useUploadTerms();
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = async (file: File | undefined) => {
    if (!file) return;

    // Checked here as well as on the server, so the answer comes at the button.
    if (file.type !== 'application/pdf') {
      toast.error('Upload the terms as a PDF');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('That file is too large', 'Keep the terms under 10 MB.');
      return;
    }

    try {
      const updated = await upload.mutateAsync(file);
      toast.success(
        `Version ${String(updated.current?.version ?? '')} uploaded`,
        'Customers who sign online are asked to sign it on their next sign-in.',
      );
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  const view = async (document: TermsDocument) => {
    // Reserved before the await — see `useDocumentTab`.
    const deliver = openTab();
    try {
      deliver(await terms.versionUrl(document.version));
    } catch (caught) {
      const described = describeError(caught);
      toast.error(described.title, described.detail);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Terms and conditions</CardTitle>
        <CardDescription>
          The PDF a new customer signs on first sign-in, with the director’s guarantee. Only
          customers opened with “Email them the onboarding link” are asked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {library.error ? (
          <ErrorState
            title={describeError(library.error).title}
            description={describeError(library.error).detail}
            onRetry={() => void library.refetch()}
          />
        ) : library.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            {library.data.current === null ? (
              <Alert variant="warning" title="No terms uploaded yet">
                Until there is a version to sign, new customers are not asked to sign anything.
              </Alert>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
                <FileTextIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {library.data.current.fileName}
                    <Badge variant="success">Current · version {library.data.current.version}</Badge>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Uploaded {formatDateTime(library.data.current.uploadedAt)} by{' '}
                    {library.data.current.uploadedBy}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (library.data.current) void view(library.data.current);
                  }}
                >
                  View
                </Button>
              </div>
            )}

            <div>
              <Button
                variant="outline"
                disabled={upload.isPending}
                onClick={() => {
                  inputRef.current?.click();
                }}
              >
                {upload.isPending ? <Spinner className="text-current" /> : <UploadIcon aria-hidden />}
                {library.data.current === null ? 'Upload the terms (PDF)' : 'Upload a new version'}
              </Button>
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                className="sr-only"
                aria-label="Terms and conditions PDF"
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </div>

            {library.data.versions.length > 1 && (
              <div>
                <h3 className="mb-1 text-sm font-medium">Earlier versions</h3>
                <ul className="divide-y divide-border">
                  {library.data.versions.slice(1).map((document) => (
                    <li key={document.version} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        Version {document.version} · {document.fileName}
                        <span className="block text-xs text-muted-foreground">
                          {formatDateTime(document.uploadedAt)} · {document.uploadedBy}
                        </span>
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => void view(document)}>
                        View
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
