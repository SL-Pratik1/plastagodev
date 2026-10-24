import type { TermsSigning } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * Terms and conditions (Matt, 21 Oct).
 *
 * Its own keys rather than the settings tree: the library changes on its own,
 * and a new version must reach the customer's portal gate without waiting for
 * a settings refetch.
 */
const termsKeys = {
  library: ['terms', 'library'] as const,
  portalStatus: [...queryKeys.portal.all, 'terms'] as const,
};

export function useTermsLibrary() {
  const { terms } = useServices();
  return useQuery({ queryKey: termsKeys.library, queryFn: () => terms.library() });
}

export function useUploadTerms() {
  const { terms } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => terms.upload(file),
    onSuccess: (library) => {
      queryClient.setQueryData(termsKeys.library, library);
    },
  });
}

/** Where this customer administrator is with signing — the first-login steps. */
export function usePortalTermsStatus() {
  const { terms } = useServices();
  return useQuery({ queryKey: termsKeys.portalStatus, queryFn: () => terms.status() });
}

/**
 * Signing lifts the gate, so everything the portal holds is re-read — the scope
 * says "go ahead" and the screens behind it load for the first time.
 */
export function useSignTerms() {
  const { terms } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TermsSigning) => terms.sign(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.portal.all });
    },
  });
}
