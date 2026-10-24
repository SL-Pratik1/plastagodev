import { DRIVER_LIST_DEFAULTS, type DriverListOption, type Role } from '@plastago/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSettingsRepository } from './helpers/fake-settings.js';

/**
 * Settings → Driver lists (Matt, 21 Oct: *"I need to be able to edit what
 * they're asked from the admin section"*).
 *
 * The rules ARE the feature. A job keeps the key of the reason a driver gave
 * and reads its wording from the list, so an option that could be removed or
 * reworded would rewrite what a driver answered last month.
 */

let repo: ReturnType<typeof createFakeSettingsRepository>;

// A GETTER, not a value: `vi.mock` factories hoist above every import.
vi.mock('../src/domains/settings/settings.repository.js', () => ({
  get settingsRepository() {
    return repo.repository;
  },
}));

const { resolveDriverList, settingsService } = await import(
  '../src/domains/settings/settings.service.js'
);

const ADMIN = { roles: ['super-admin'] as Role[], accountId: null, name: 'Matthew Keane' };
const OPS = { roles: ['operations'] as Role[], accountId: null };
const DRIVER = { roles: ['driver'] as Role[], accountId: null };

const CURRENT: DriverListOption[] = [
  { key: 'site-not-ready', label: 'Site not ready', active: true },
  { key: 'weather', label: 'Weather', active: false },
];

/** The list as the screen sends it back, unchanged. */
const asWritten = (options: readonly DriverListOption[]) =>
  options.map(({ key, label, active }) => ({ key: key as string | null, label, active }));

beforeEach(() => {
  repo = createFakeSettingsRepository();
});

describe('saving a driver list', () => {
  it('names a new option from its wording', () => {
    const saved = resolveDriverList(CURRENT, [
      ...asWritten(CURRENT),
      { key: null, label: 'Gate locked', active: true },
    ]);

    expect(saved.at(-1)).toEqual({ key: 'gate-locked', label: 'Gate locked', active: true });
  });

  it('numbers a new key that is already taken, by a switched-off option too', () => {
    const saved = resolveDriverList(CURRENT, [
      ...asWritten(CURRENT),
      { key: null, label: 'Weather!', active: true },
    ]);

    expect(saved.at(-1)?.key).toBe('weather-2');
  });

  it('refuses to remove an option — it is switched off instead', () => {
    expect(() => resolveDriverList(CURRENT, asWritten(CURRENT).slice(0, 1))).toThrow(
      /"Weather" can't be removed — switch it off instead/,
    );
  });

  it('refuses to reword an option — the new wording is a new option', () => {
    expect(() =>
      resolveDriverList(CURRENT, [
        { key: 'site-not-ready', label: 'Site still being built', active: true },
        ...asWritten(CURRENT).slice(1),
      ]),
    ).toThrow(/can't be reworded/);
  });

  it('refuses a list with nothing switched on', () => {
    expect(() =>
      resolveDriverList(
        CURRENT,
        asWritten(CURRENT).map((row) => ({ ...row, active: false })),
      ),
    ).toThrow(/at least one option switched on/);
  });

  it('refuses the same wording twice among the switched-on options', () => {
    expect(() =>
      resolveDriverList(CURRENT, [
        ...asWritten(CURRENT),
        { key: null, label: 'site NOT ready', active: true },
      ]),
    ).toThrow(/already on the list/);
  });

  it('refuses a key the list does not hold', () => {
    expect(() =>
      resolveDriverList(CURRENT, [
        ...asWritten(CURRENT),
        { key: 'invented', label: 'Invented', active: true },
      ]),
    ).toThrow(/not on the list/);
  });
});

describe('who can change the lists', () => {
  it('lets a Super Admin save, and keeps the change', async () => {
    const current = DRIVER_LIST_DEFAULTS.contaminationTypes;

    await settingsService.saveDriverList(
      'contaminationTypes',
      { options: [...asWritten(current), { key: null, label: 'Asbestos sheeting', active: true }] },
      ADMIN,
    );

    const lists = await settingsService.driverLists(OPS);
    expect(lists.contaminationTypes.at(-1)).toEqual({
      key: 'asbestos-sheeting',
      label: 'Asbestos sheeting',
      active: true,
    });
  });

  it('refuses Operations', async () => {
    await expect(
      settingsService.saveDriverList(
        'siteHazards',
        { options: asWritten(DRIVER_LIST_DEFAULTS.siteHazards) },
        OPS,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps the office read away from a driver (the app has its own route)', async () => {
    await expect(settingsService.driverLists(DRIVER)).rejects.toMatchObject({ status: 403 });
  });
});
