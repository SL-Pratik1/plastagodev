import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { ZoneOption } from '@/services/types';
import { useServices } from '@/services/services-context';

/**
 * Reference lists for pickers and filters.
 *
 * Cached for an hour and never refetched on mount: the account list does not
 * change while someone fills in a form, and re-requesting it every time a filter
 * bar renders is pure waste. This is the one place a long `staleTime` is
 * unambiguously right.
 */
const REFERENCE_CACHE = { staleTime: 60 * 60 * 1000, gcTime: 60 * 60 * 1000 } as const;

export function useAccountOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.accounts(),
    queryFn: () => lookups.accounts(),
    ...REFERENCE_CACHE,
  });
}

export function useBuilderOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.builders(),
    queryFn: () => lookups.builders(),
    ...REFERENCE_CACHE,
  });
}

export function useDriverOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.drivers(),
    queryFn: () => lookups.drivers(),
    ...REFERENCE_CACHE,
  });
}

/**
 * M6.1 — the rate cards an account can be assigned to.
 *
 * ⚠️ Invalidated whenever a card is added, renamed or retired, through
 * `queryKeys.lookups.all` — the settings mutations already do that. Without it
 * a card created on the Pricing tab would not appear in the new-customer form
 * until the hour-long reference cache expired.
 */
export function useRateCardOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.rateCards(),
    queryFn: () => lookups.rateCards(),
    ...REFERENCE_CACHE,
  });
}

/**
 * M6.3 — the service zones, for every picker, filter and label.
 *
 * ⚠️ Invalidated whenever a zone is added, renamed, reordered or retired,
 * through `queryKeys.lookups.all` — the pricing mutations already do that.
 * Without it a zone created on the Pricing tab would be invisible everywhere
 * else for the rest of the session, which reads as the save having failed.
 *
 * ── Archived zones are INCLUDED here ─────────────────────────────────────
 * Deliberately. Use `useSelectableZones` for anything somebody picks FROM;
 * this list is also what names a retired zone on a job booked last March.
 */
export function useZoneOptions() {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.zones(),
    queryFn: () => lookups.zones(),
    ...REFERENCE_CACHE,
  });
}

/**
 * The zones a form may offer.
 *
 * ⚠️ Archived zones are filtered out, EXCEPT the one the record already has.
 * A lead captured against a zone retired last week must still convert without
 * silently re-zoning the account — so `keep` puts that one back, and only that
 * one.
 */
export function useSelectableZones(keep?: string | null): ZoneOption[] {
  const zones = useZoneOptions().data ?? [];
  return zones.filter((zone) => !zone.archived || zone.value === keep);
}

/**
 * Address lookup (Matt, 7:25).
 *
 * Keyed by the query so each distinct set of keystrokes is cached separately —
 * backspacing then retyping the same thing hits the cache rather than the
 * service. The same long cache applies: the list of suburbs PlastaGo services
 * does not change while somebody fills in a form.
 */
export function usePlaceOptions(query: string) {
  const { lookups } = useServices();
  return useQuery({
    queryKey: queryKeys.lookups.places(query),
    queryFn: () => lookups.places(query),
    ...REFERENCE_CACHE,
  });
}
