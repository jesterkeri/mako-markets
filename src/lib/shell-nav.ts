// The four main destinations of the redesign (desktop nav pills, mobile tab bar), and which one a route lights.

export type NavKey = 'rounds' | 'pools' | 'leaderboard' | 'me';

export const NAV: readonly { key: NavKey; label: string; href: string }[] = [
  { key: 'rounds', label: 'Rounds', href: '/rounds' },
  { key: 'pools', label: 'Pools', href: '/pools' },
  { key: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
  { key: 'me', label: 'Me', href: '/me' },
];

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/// The destination a route belongs to, or null when none is lit (sign-in, legal, a profile, 404). Home lights
/// Rounds, as in the design: it opens on the next round.
export function activeNav(pathname: string): NavKey | null {
  if (pathname === '/' || under(pathname, '/rounds')) return 'rounds';
  if (under(pathname, '/pools')) return 'pools';
  if (under(pathname, '/leaderboard')) return 'leaderboard';
  if (under(pathname, '/me') || under(pathname, '/settings') || under(pathname, '/notifications')) return 'me';
  return null;
}

/// Where "Sign in" goes. The redesigned /signin (14a) replaces /signup in a later step; until then it is /signup.
export const SIGN_IN_HREF = '/signup';
