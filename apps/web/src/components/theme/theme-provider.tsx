import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, readStoredTheme, storeTheme, type ThemeMode } from '@/lib/theme';
import { ThemeContext, type ThemeContextValue } from './theme-context';

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Read during initialisation rather than in an effect, so the first paint is
  // already correct and there is no flash of the wrong theme.
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const stored = readStoredTheme();
    applyTheme(stored);
    return stored;
  });

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    applyTheme(next);
    storeTheme(next);
  }, []);

  // Keep in step if the OS theme changes while the app is open and we are
  // following it — otherwise the console stays light after sunset.
  useEffect(() => {
    if (mode !== 'system') return;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      applyTheme('system');
    };

    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode }), [mode, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
