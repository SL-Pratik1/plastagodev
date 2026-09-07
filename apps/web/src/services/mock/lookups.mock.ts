import type { Place } from '@plastago/shared';
import { ACCOUNTS, DRIVERS, SUBURBS } from './fixtures/reference';
import { latency } from './mock-transport';
import { store } from './store';
import type { LookupService } from '../types';

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
      /*
       * Derived from the JOBS, not from a site register.
       *
       * The builder is still a property of the work rather than of the account
       * (M1.2) — iPlasta is invoiced while GJ Gardner is the builder on site.
       * The site register that used to carry it is gone (Matt, 0:29), so the
       * list comes from where the name is actually recorded now.
       */
      const names = new Set(
        store.jobs.map((job) => job.builderName).filter((name) => name !== '' && name !== '—'),
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

    /**
     * Address lookup (Matt, 7:25).
     *
     * ── Why this is a search and not a dropdown ───────────────────────────
     * A dropdown of every suburb PlastaGo services is already too long to scan
     * and gets longer. Matt described typing: *"as you're typing in an address,
     * it will tell you the suburbs that address could be in."*
     *
     * ── Matching on postcode as well as name ──────────────────────────────
     * Because half the time the person booking has the postcode in front of them
     * on a purchase order and not the suburb name — and because two suburbs in
     * this table share a postcode (Austral and Leppington are both 2179), so the
     * postcode alone is a narrowing, not an answer. Both are offered and the
     * human picks.
     */
    async places(query: string) {
      await latency(90, 50);

      const needle = query.trim().toLowerCase();
      const matches =
        needle === ''
          ? SUBURBS
          : SUBURBS.filter(
              (place) =>
                place.suburb.toLowerCase().includes(needle) || place.postcode.startsWith(needle),
            );

      return matches
        .map<Place>((place) => ({
          // Slugged rather than an index, so an id survives the table being
          // reordered or a suburb being inserted in the middle of it.
          id: place.suburb.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          suburb: place.suburb,
          postcode: place.postcode,
          state: 'NSW',
          zone: place.zone,
          latitude: place.lat,
          longitude: place.lng,
          label: `${place.suburb} NSW ${place.postcode}`,
        }))
        .sort((a, b) => {
          // A prefix match is what the typist meant; a mid-word match is a maybe.
          const aStarts = a.suburb.toLowerCase().startsWith(needle);
          const bStarts = b.suburb.toLowerCase().startsWith(needle);
          if (aStarts !== bStarts) return aStarts ? -1 : 1;
          return a.suburb.localeCompare(b.suburb);
        })
        .slice(0, 8);
    },
  };
}
