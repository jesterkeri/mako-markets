'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'mako-theme';

type ThemeContextValue = {
  theme: Theme;
  setTheme: (next: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Single source of truth for the active theme. Wraps the app so every
 * `<ThemeToggle />` (mobile header, desktop header, future profile page,
 * etc.) shares one piece of state instead of each holding its own — that
 * was the cause of cross-toggle desync where flipping one pill left the
 * other showing the wrong active half.
 *
 * The provider hydrates from `<html data-theme>` (set by THEME_BOOT_SCRIPT
 * before React paints), so SSR and first client render agree on the value.
 *
 * setTheme is the ONLY caller that should write `data-theme` from React;
 * all consumers read from context, not the DOM. The boot script writes the
 * attribute exactly once at load.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  // SSR-safe initial: 'dark' is the same fallback the boot script uses if
  // localStorage and matchMedia both fail. The first effect below corrects
  // it from the live <html data-theme> on mount.
  const [theme, setThemeState] = useState<Theme>('dark');

  useEffect(() => {
    const live = (document.documentElement.dataset.theme as Theme) ?? 'dark';
    if (live !== theme) {
      setThemeState(live);
    }
    // Intentionally one-shot — we own writes from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage may be disabled (private mode); data-theme is still
      // authoritative for the current session
    }
    setThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the current theme + a setter from the nearest ThemeProvider. Throws
 * if used outside the provider — unlike a silent fallback, this catches
 * misplacement at the boundary instead of letting a stale 'dark' default
 * leak into pages that should follow the user's choice.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/**
 * Inline-script source. Runs in `<head>` before any React render so the
 * correct `data-theme` is on `<html>` on first paint — no flash.
 *
 * Pulled into a constant rather than embedded as a literal because
 * `dangerouslySetInnerHTML` requires the exact string.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');if(s==='light'||s==='dark'){document.documentElement.dataset.theme=s;return;}var m=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=m?'dark':'light';}catch(e){document.documentElement.dataset.theme='dark';}})();`;
