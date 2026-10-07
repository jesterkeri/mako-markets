// Icon paths from the redesign's design file (24x24 viewBox). Stroke icons are drawn with a 1.75 stroke unless
// noted; the tab bar uses the filled "soft" set.

export const TAB_ICON: Record<'pools' | 'rounds' | 'news' | 'leaderboard' | 'me', string> = {
  // News: a folded newspaper, drawn to match the filled set (cut-outs via evenodd).
  news: 'M5.2 4h11.1a1.7 1.7 0 0 1 1.7 1.7V18a1.9 1.9 0 0 0 1.9 1.9H6.1A3.2 3.2 0 0 1 2.9 16.7V6.3A2.3 2.3 0 0 1 5.2 4zM18.9 8.2h1.2a1 1 0 0 1 1 1v8.7a1.6 1.6 0 0 1-2.2 1.5zM6.4 7.6v3.6h8.2V7.6zM6.4 13v1.6h8.2V13zM6.4 16.2v1.6h5.6v-1.6z',
  rounds:
    'M9.6 2h4.8a1 1 0 0 1 0 2H9.6a1 1 0 0 1 0-2zM12 5.2a8.3 8.3 0 1 1 0 16.6 8.3 8.3 0 0 1 0-16.6zM11.1 9v5.1l3.6 2.2.95-1.55-2.75-1.65V9z',
  pools:
    'M6.25 11a1.75 1.75 0 0 1 1.75 1.75v5.75a1.75 1.75 0 0 1-3.5 0v-5.75A1.75 1.75 0 0 1 6.25 11zM12 4a1.75 1.75 0 0 1 1.75 1.75V18.5a1.75 1.75 0 0 1-3.5 0V5.75A1.75 1.75 0 0 1 12 4zM17.75 7.5a1.75 1.75 0 0 1 1.75 1.75v9.25a1.75 1.75 0 0 1-3.5 0V9.25a1.75 1.75 0 0 1 1.75-1.75z',
  leaderboard:
    'M7 3.5h10v5.2a5 5 0 0 1-10 0V3.5zM17.6 5h2.2a.9.9 0 0 1 .9.9v.7a3.8 3.8 0 0 1-3.4 3.8V5zM6.4 5H4.2a.9.9 0 0 0-.9.9v.7a3.8 3.8 0 0 0 3.4 3.8V5zM10.7 13.4h2.6v3.1h-2.6zM8.2 18.3a1.6 1.6 0 0 1 1.6-1.6h4.4a1.6 1.6 0 0 1 1.6 1.6v1.9H8.2z',
  me: 'M9.2 6.6V5.4A1.9 1.9 0 0 1 11.1 3.5h1.8a1.9 1.9 0 0 1 1.9 1.9v1.2h-1.7V5.3h-2.2v1.3zM4.9 7.3h14.2a2.4 2.4 0 0 1 2.4 2.4v8.4a2.4 2.4 0 0 1-2.4 2.4H4.9a2.4 2.4 0 0 1-2.4-2.4V9.7a2.4 2.4 0 0 1 2.4-2.4zM10.3 12.2v2.4h3.4v-2.4z',
};

export const ICON = {
  bell: 'M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.8-3.8',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sunRays: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  chevronDown: 'M6 9l6 6 6-6',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  help: 'M12 17h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  legal: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  signOut: 'M15 17l5-5-5-5M20 12H9M11 4H5v16h6',
  /// Send and receive: an arrow out and an arrow in.
  transfer: 'M7 7h11l-3-3M18 7l-3 3M17 17H6l3 3M6 17l3-3',
  feedback: 'M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM8 10h8M8 13h5',
} as const;

type StrokeIconProps = { d: string; size?: number; strokeWidth?: number; className?: string };

/// A stroked line icon in the current text colour.
export function StrokeIcon({ d, size = 16, strokeWidth = 1.75, className }: StrokeIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

/// The sun: a filled-outline circle plus rays (the design draws it with a 2.5 stroke).
export function SunIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d={ICON.sunRays} />
    </svg>
  );
}
