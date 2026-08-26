import { Badge, Button, Input, Select } from '@plastago/ui';
import { SearchIcon, XIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { ListQueryController } from './use-list-query';
import type { FilterDefinition } from './types';

export interface DataTableToolbarProps {
  controller: ListQueryController;
  searchPlaceholder?: string;
  filters?: readonly FilterDefinition[];
  /** Buttons that act on the list as a whole — "Invite user", "Export". */
  actions?: ReactNode;
}

/**
 * Search, filters and list actions.
 *
 * Filters use native `<select>` rather than a custom popover: on a phone that
 * gives the full-height system picker, and on desktop it gives type-ahead for
 * free. A filter is a value being chosen, which is exactly what a select is for.
 *
 * The "Clear" affordance only appears once something is actually narrowing the
 * list, and the active count is shown next to it — a grid returning nothing
 * because of a filter set two screens ago is the most common "the app is broken"
 * report there is.
 */
export function DataTableToolbar({
  controller,
  searchPlaceholder = 'Search…',
  filters,
  actions,
}: DataTableToolbarProps) {
  const searchId = useId();

  return (
    <div className="flex flex-col gap-3 border-b border-border p-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <label htmlFor={searchId} className="sr-only">
            Search this list
          </label>
          <Input
            id={searchId}
            type="search"
            value={controller.searchInput}
            onChange={(event) => {
              controller.setSearchInput(event.target.value);
            }}
            placeholder={searchPlaceholder}
            autoComplete="off"
            className="pr-8 pl-8"
          />
          {controller.searchInput && (
            <button
              type="button"
              onClick={() => {
                controller.setSearchInput('');
              }}
              className="focus-ring absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:text-foreground"
            >
              <XIcon aria-hidden className="size-3.5" />
              <span className="sr-only">Clear search</span>
            </button>
          )}
        </div>

        {filters?.map((filter) => (
          <div key={filter.key} className="sm:w-40">
            <label htmlFor={`filter-${filter.key}`} className="sr-only">
              {filter.label}
            </label>
            <Select
              id={`filter-${filter.key}`}
              value={controller.filters[filter.key] ?? ''}
              onChange={(event) => {
                controller.setFilter(filter.key, event.target.value || undefined);
              }}
            >
              <option value="">{filter.allLabel ?? `All ${filter.label.toLowerCase()}`}</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ))}

        {controller.isFiltered && (
          <div className="flex items-center gap-2">
            {controller.activeFilterCount > 0 && (
              <Badge variant="secondary">
                {controller.activeFilterCount} filter
                {controller.activeFilterCount === 1 ? '' : 's'}
              </Badge>
            )}
            <Button variant="ghost" size="sm" onClick={controller.clearFilters}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
