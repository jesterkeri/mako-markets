'use client';

import { useTheme } from '@/lib/use-theme';

/**
 * Segmented pill toggle for light/dark theme. Sun/moon glyphs only — text
 * labels were too verbose for the chrome row. Active half gets a chrome-fg
 * fill (inverts on theme flip); inactive half is a transparent glyph that
 * blends with the chrome.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  const baseHalf =
    'flex items-center justify-center w-7 h-7 rounded-full transition-colors';
  const activeHalf = 'bg-chrome-fg text-chrome';
  const idleHalf = 'text-chrome-fg/60 hover:text-chrome-fg';

  return (
    <div
      role="group"
      aria-label="Theme"
      className={`inline-flex items-center gap-0.5 p-0.5 rounded-full border border-chrome-divider ${className ?? ''}`}
    >
      <button
        type="button"
        onClick={() => setTheme('light')}
        aria-pressed={theme === 'light'}
        aria-label="Light theme"
        className={`${baseHalf} ${theme === 'light' ? activeHalf : idleHalf}`}
      >
        <SunIcon />
      </button>
      <button
        type="button"
        onClick={() => setTheme('dark')}
        aria-pressed={theme === 'dark'}
        aria-label="Dark theme"
        className={`${baseHalf} ${theme === 'dark' ? activeHalf : idleHalf}`}
      >
        <MoonIcon />
      </button>
    </div>
  );
}

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}
