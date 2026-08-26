import { PAGE_SIZE_DEFAULT } from '@plastago/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ListQuery } from '@/services/types';

export interface UseListQueryOptions {
  /** Filter keys this screen owns. Anything else in the URL is ignored. */
  filterKeys?: readonly string[];
  defaultPageSize?: number;
  /** Initial sort, e.g. `'-createdAt'`. */
  defaultSort?: string;
  /**
   * Namespaces every param, e.g. `'sites'` → `sites.page`, `sites.q`.
   *
   * Needed when one screen holds more than one list — a customer detail page has
   * a sites tab, a jobs tab and an invoices tab, and without a prefix all three
   * would fight over `page` and `q`. Switching tab would then inherit the
   * previous tab's search, which reads as a bug.
   */
  paramPrefix?: string;
}

export interface ListQueryController {
  /** Ready to hand straight to a service call. */
  query: ListQuery;
  /** Immediate input value — the URL and query follow after a debounce. */
  searchInput: string;
  setSearchInput: (value: string) => void;
  sort: string | undefined;
  toggleSort: (sortKey: string) => void;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  filters: Readonly<Record<string, string | undefined>>;
  setFilter: (key: string, value: string | undefined) => void;
  clearFilters: () => void;
  activeFilterCount: number;
  /** True when a search or filter is narrowing the list. */
  isFiltered: boolean;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * List state, held in the URL.
 *
 * ── Why the URL and not component state ────────────────────────────────────
 * Because the office works in pairs and in tabs. "Show me every unallocated job
 * with a ready date in the next 3 days in the Newcastle zone" (§M2.2) is a view
 * someone needs to bookmark, paste into a message, and still have after a
 * refresh. Filters in `useState` cannot be any of those, and lose their place on
 * every back-navigation from a detail page — which is the most-repeated
 * interaction in a console like this.
 *
 * ── How the search box stays responsive without fighting the URL ───────────
 * The URL is the source of truth; local state holds only an uncommitted draft,
 * and `null` means "follow the URL". Typing sets the draft and restarts a timer;
 * the timer clears the draft and writes the URL in one go.
 *
 * The alternative — mirroring the URL back into state with an effect — is the
 * obvious implementation and the wrong one: it calls setState inside an effect
 * body on every URL change, cascading a render, and it needs a guard to avoid
 * looping. This way the browser Back button just works, because once a search is
 * committed there is no local copy to disagree with the URL.
 *
 * Two more details that matter:
 *  • The search commit uses `replace`, so typing "Clarendon" does not stack ten
 *    entries in the browser history.
 *  • Any change to the search, a filter or the page size **resets to page 1**.
 *    Landing on page 4 of a 2-page result is an empty grid that looks broken.
 */
export function useListQuery({
  filterKeys = [],
  defaultPageSize = PAGE_SIZE_DEFAULT,
  defaultSort,
  paramPrefix,
}: UseListQueryOptions = {}): ListQueryController {
  const [params, setParams] = useSearchParams();

  const key = useCallback(
    (name: string) => (paramPrefix ? `${paramPrefix}.${name}` : name),
    [paramPrefix],
  );

  const urlSearch = params.get(key('q')) ?? '';
  const [draftSearch, setDraftSearch] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending keystroke must not commit after the screen has gone.
  useEffect(
    () => () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    },
    [],
  );

  const update = useCallback(
    (
      mutate: (next: URLSearchParams) => void,
      options?: { keepPage?: boolean; replace?: boolean },
    ) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          mutate(next);
          if (!options?.keepPage) next.delete(key('page'));
          return next;
        },
        options?.replace ? { replace: true } : undefined,
      );
    },
    [setParams, key],
  );

  const setSearchInput = useCallback(
    (value: string) => {
      setDraftSearch(value);

      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        // Release the draft in the same tick as the commit, so the input never
        // shows a value the URL disagrees with.
        setDraftSearch(null);
        update(
          (next) => {
            if (value) next.set(key('q'), value);
            else next.delete(key('q'));
          },
          { replace: true },
        );
      }, SEARCH_DEBOUNCE_MS);
    },
    [update, key],
  );

  const page = Math.max(1, Number(params.get(key('page')) ?? '1') || 1);
  const pageSize = Math.max(
    1,
    Number(params.get(key('pageSize')) ?? String(defaultPageSize)) || defaultPageSize,
  );
  const sort = params.get(key('sort')) ?? defaultSort;

  // Joined to a string so the dependency is a stable primitive: call sites pass
  // a literal array, which would otherwise be a new reference every render.
  const filterKeyList = filterKeys.join(',');

  const filters = useMemo(() => {
    const keys = filterKeyList ? filterKeyList.split(',') : [];
    const entries: Record<string, string | undefined> = {};
    for (const name of keys) {
      const value = params.get(key(name));
      if (value) entries[name] = value;
    }
    return entries;
  }, [params, filterKeyList, key]);

  const activeFilterCount = Object.keys(filters).length;

  const toggleSort = useCallback(
    (sortKey: string) => {
      update(
        (next) => {
          const currentSort = next.get(key('sort')) ?? defaultSort;
          // Ascending → descending → unsorted. The third state matters: it is
          // how you get back to the server's default order.
          if (currentSort === sortKey) next.set(key('sort'), `-${sortKey}`);
          else if (currentSort === `-${sortKey}`) next.delete(key('sort'));
          else next.set(key('sort'), sortKey);
        },
        { keepPage: true },
      );
    },
    [update, defaultSort, key],
  );

  const setPage = useCallback(
    (next: number) => {
      update(
        (target) => {
          if (next <= 1) target.delete(key('page'));
          else target.set(key('page'), String(next));
        },
        { keepPage: true },
      );
    },
    [update, key],
  );

  const setPageSize = useCallback(
    (next: number) => {
      update((target) => {
        if (next === defaultPageSize) target.delete(key('pageSize'));
        else target.set(key('pageSize'), String(next));
      });
    },
    [update, defaultPageSize, key],
  );

  const setFilter = useCallback(
    (name: string, value: string | undefined) => {
      update((target) => {
        if (value) target.set(key(name), value);
        else target.delete(key(name));
      });
    },
    [update, key],
  );

  const clearFilters = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    setDraftSearch(null);

    update((target) => {
      target.delete(key('q'));
      for (const name of filterKeyList ? filterKeyList.split(',') : []) target.delete(key(name));
    });
  }, [update, filterKeyList, key]);

  return {
    query: {
      page,
      pageSize,
      sort: sort ?? undefined,
      q: urlSearch || undefined,
      filters,
    },
    searchInput: draftSearch ?? urlSearch,
    setSearchInput,
    sort: sort ?? undefined,
    toggleSort,
    setPage,
    setPageSize,
    filters,
    setFilter,
    clearFilters,
    activeFilterCount,
    isFiltered: activeFilterCount > 0 || urlSearch.length > 0,
  };
}
