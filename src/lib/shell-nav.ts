// The main destinations (desktop nav pills, mobile tab bar), and which one a route lights. Joshua, 2026-10-07 (after
// the mobile beta test): no Home tab; Pools first; News (the Market intel page, /news) its own tab, on desktop and
// mobile alike. The desktop Home page stays as the front page behind the logo; on mobile, / goes to Pools.

export type NavKey = 'pools' | 'rounds' | 'news' | 'leaderboard' | 'me';

export const NAV: readonly { key: NavKey; label: string; href: string }[] = [
  { key: 'pools', label: 'Pools', href: '/pools' },
  { key: 'rounds', label: 'Rounds', href: '/rounds' },
  { key: 'news', label: 'News', href: '/news' },
  { key: 'leaderboard', label: 'Leaderboard', href: '/leaderboard' },
  { key: 'me', label: 'Me', href: '/me' },
];

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/// The destination a route belongs to, or null when none is lit (the desktop Home page, sign-in, legal, a profile,
/// 404).
export function activeNav(pathname: string): NavKey | null {
  if (under(pathname, '/pools')) return 'pools';
  if (under(pathname, '/rounds')) return 'rounds';
  if (under(pathname, '/news')) return 'news';
  if (under(pathname, '/leaderboard')) return 'leaderboard';
  if (under(pathname, '/me') || under(pathname, '/settings') || under(pathname, '/notifications')) return 'me';
  return null;
}

/// Detail pages (one pool, one round) bring their own mobile header and bottom bar in place of the shell's
/// header and tab bar, as the design draws them (9a, 5a).
export function isMobileDetail(pathname: string): boolean {
  // A pool or round, and its full chart page (which must own the whole phone screen, portrait or landscape).
  return /^\/(pools|rounds)\/\d+(\/chart)?\/?$/.test(pathname);
}

/// The sign-in route (14a). "Sign in" buttons open the dialog in place; this is where they link to.
export const SIGN_IN_HREF = '/signin';
