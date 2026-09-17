import type { Place, PlaceWrite } from '@plastago/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useServices } from '@/services/services-context';

/**
 * The suburbs PlastaGo services (M6.3).
 *
 * ── Why this table matters more than its size suggests ────────────────────
 * A job is zoned by its suburb, and the zone decides the service charge and the
 * per-m² rate. So this is the table that connects "we now collect from Gregory
 * Hills" to what the invoice says — and it is the only way a newly opened zone
 * becomes reachable at all.
 */

/**
 * Every suburb, archived included.
 *
 * Unpaged on purpose: this is the list of places one business collects from,
 * and it will be hundreds of rows at most. A page control here would be
 * scaffolding around a list that fits in a scroll.
 */
export function useSuburbList() {
  const { suburbs } = useServices();
  return useQuery({
    queryKey: queryKeys.suburbs.list(),
    queryFn: () => suburbs.list(),
  });
}

/**
 * A suburb write.
 *
 * ⚠️ Invalidates `lookups.all` as well as its own domain, and that is the whole
 * reason this wrapper exists rather than three bare `useMutation` calls. The
 * place type-ahead behind every booking form is cached for an HOUR
 * (`REFERENCE_CACHE`), so a suburb added here would be unfindable in the
 * job-create form for the rest of the session — which reads as the save having
 * silently failed. Exactly the trap `usePricingMutation` documents for rate
 * cards.
 *
 * `settings.all` too: the Zones card counts the suburbs pointing at each zone,
 * and that count is the difference between "new zone" and "new zone that works".
 */
function useSuburbMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.suburbs.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.lookups.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings.all });
    },
  });
}

export function useCreateSuburb() {
  const { suburbs } = useServices();
  return useSuburbMutation((draft: PlaceWrite) => suburbs.create(draft));
}

export function useUpdateSuburb() {
  const { suburbs } = useServices();
  return useSuburbMutation((input: { id: string; draft: PlaceWrite }) =>
    suburbs.update(input.id, input.draft),
  );
}

/** Resolves to the archived row, or null when the suburb was really deleted. */
export function useRemoveSuburb() {
  const { suburbs } = useServices();
  return useSuburbMutation<string, Place | null>((id: string) => suburbs.remove(id));
}

export function useRestoreSuburb() {
  const { suburbs } = useServices();
  return useSuburbMutation((id: string) => suburbs.restore(id));
}
