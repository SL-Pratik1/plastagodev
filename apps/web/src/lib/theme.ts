/**
 * Theme mode plumbing.
 *
 * The tokens in `@plastago/ui` are declared once with `light-dark()` and resolve
 * off `color-scheme`, so switching theme is exactly one class on `<html>` —
 * `.light`, `.dark`, or neither to follow the operating system. No token is
 * redeclared per theme.
 *
 * Three modes rather than a boolean, because "follow my system" is the setting
 * most people actually want and a two-state toggle cannot express it.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = 'plastago.theme';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

export function readStoredTheme(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    // Site data blocked. Following the OS is the right default anyway.
    return 'system';
  }
}

export function storeTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Preference is lost on reload; the app still works.
  }
}

/** Applies the mode by swapping the class the tokens key off. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (mode !== 'system') root.classList.add(mode);
}
