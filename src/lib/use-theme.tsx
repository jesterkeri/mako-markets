'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';
/// What the user chose. 'auto' follows the device, live (Settings > Appearance: Light / Dark / Auto).
export type ThemePreference = Theme | 'auto';

const STORAGE_KEY = 'mako-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type ThemeContextValue = {
  /// The theme on screen now.
  theme: Theme;
  /// The user's choice; 'auto' until they pick one.
  preference: ThemePreference;
  /// Pick light or dark explicitly (the desktop header switch).
  setTheme: (next: Theme) => void;
  /// Pick light, dark or auto (Settings > Appearance).
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

// The theme lives on <html data-theme data-theme-pref> (the boot script sets it before first paint). React reads
// it as an external store; every write goes through apply(), which notifies the readers.
const listeners = new Set<() => void>();

function apply(theme: Theme, preference: ThemePreference): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePref = preference;
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

const readTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
const readPreference = (): ThemePreference => {
  const pref = document.documentElement.dataset.themePref;
  return pref === 'light' || pref === 'dark' ? pref : 'auto';
};

/**
 * Single source of truth for the active theme. Wraps the app so every theme control shares one piece of state
 * instead of each holding its own (that was the cause of cross-toggle desync).
 *
 * Reads `<html data-theme data-theme-pref>` (server render: dark, auto). While the preference is 'auto' it
 * follows the device's colour scheme as it changes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'dark' as const);
  const preference = useSyncExternalStore(subscribe, readPreference, () => 'auto' as const);

  // Auto: follow the device when it switches between light and dark.
  useEffect(() => {
    if (preference !== 'auto') return;
    const query = window.matchMedia(DARK_QUERY);
    const follow = () => apply(systemTheme(), 'auto');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    apply(next === 'auto' ? systemTheme() : next, next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be disabled (private mode); the attributes still hold for this session.
    }
  }, []);

  const setTheme = useCallback((next: Theme) => setPreference(next), [setPreference]);

  const value = useMemo(
    () => ({ theme, preference, setTheme, setPreference }),
    [theme, preference, setTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the current theme and setters from the nearest ThemeProvider. Throws if used outside the provider, so a
 * misplacement fails at the boundary instead of a stale default leaking into pages.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/**
 * Inline-script source. Runs in `<head>` before any React render so the correct `data-theme` is on `<html>` on
 * first paint, with no flash. A stored 'light' or 'dark' wins; 'auto' or nothing stored follows the device.
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document.documentElement.dataset;try{var s=localStorage.getItem('${STORAGE_KEY}');if(s==='light'||s==='dark'){d.theme=s;d.themePref=s;return;}d.themePref='auto';d.theme=window.matchMedia('${DARK_QUERY}').matches?'dark':'light';}catch(e){d.theme='dark';d.themePref='auto';}})();`;
