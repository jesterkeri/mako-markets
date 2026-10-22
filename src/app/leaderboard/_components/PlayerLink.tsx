import Link from 'next/link';

import { profileHref, type PlayerView } from '@/lib/leaderboard/board-view';

/// A player's row, card or bar: a link to their profile when they have one (a Mako Market account), else the same box
/// as plain markup, so a bettor who never signed in is never a link to a page that does not exist.
export function PlayerLink({ p, style, children, ...rest }: { p: PlayerView; style: React.CSSProperties; children: React.ReactNode; 'aria-label'?: string }) {
  return p.registered ? (
    <Link href={profileHref(p.actor)} style={style} {...rest}>
      {children}
    </Link>
  ) : (
    <div style={style} {...rest}>
      {children}
    </div>
  );
}
