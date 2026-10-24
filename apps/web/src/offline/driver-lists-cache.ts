import { DRIVER_LIST_DEFAULTS, DriverListsSchema, type DriverLists } from '@plastago/shared';

const CACHE_KEY = 'plastago.driver-lists';

/**
 * The lists as the phone last heard them, else the built-in ones.
 *
 * The office edits these in Settings (Matt, 21 Oct), so the app loads them —
 * but a driver at a fence with no signal, after a reload, must still have
 * something to pick from. The built-in options are always still accepted by
 * the server: an option is never removed, only switched off.
 */
export function cachedDriverLists(): DriverLists {
  try {
    const parsed = DriverListsSchema.safeParse(
      JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? 'null'),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Blocked or corrupt storage — fall through to the built-in lists.
  }
  return DRIVER_LIST_DEFAULTS;
}

export function cacheDriverLists(lists: DriverLists): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(lists));
  } catch {
    // Private mode: the next reload offline falls back to the built-in lists.
  }
}
