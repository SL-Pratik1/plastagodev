import { ACCOUNTS, DRIVERS } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';
import type { LookupOption, LookupService } from '../types';

/**
 * Reference lists for pickers and filter dropdowns.
 *
 * Faster latency than the domain services on purpose: these populate controls,
 * and a filter dropdown that takes as long as the grid it filters feels broken.
 */
export function createMockLookupService(): LookupService {
  return {
    async accounts() {
      await latency(120, 60);
      return ACCOUNTS.filter((account) => account.status === 'active').map((account) => ({
        value: account.id,
        label: `${account.name} (${account.code})`,
      }));
    },

    async builders() {
      await latency(120, 60);
      // Distinct builders across the site register — the builder is a property of
      // the SITE, not the account (M1.2), so this is derived rather than stored.
      const names = new Set(
        store.sites.map((site) => site.builderName).filter((name) => name !== '—'),
      );
      return [...names].sort().map((name) => ({ value: name, label: name }));
    },

    async drivers() {
      await latency(120, 60);
      return DRIVERS.map((driver) => ({
        value: driver.id,
        label: driver.active ? driver.name : `${driver.name} (inactive)`,
      }));
    },

    async sitesForAccount(accountId: string) {
      await latency(140, 80);
      // Grouped by suburb: an account with 20 sites across three suburbs is far
      // easier to pick from when the list is sectioned.
      const options: LookupOption[] = store.sites
        .filter((site) => site.accountId === accountId && site.status === 'active')
        .map((site) => ({ value: site.id, label: site.name, group: site.suburb }));

      return options.sort(
        (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label),
      );
    },
  };
}
