import Link from 'next/link';

import { TONE_FG } from '@/app/leaderboard/_components/props';
import type { StandingRow as Standing } from '@/lib/competition/standings';
import { profileHref, signedUsdc2 } from '@/lib/leaderboard/board-view';
import { formatAddress } from '@/lib/user-display';

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

/// One player: place, name (a link to the profile; every entrant is a Mako Market account), profit, pools and wins.
export function StandingRow({ r, place, prize, compact }: { r: Standing; place: string; prize?: number; compact: boolean }) {
  const profit = signedUsdc2(BigInt(r.net));
  const rate = `${r.pools} ${r.pools === 1 ? 'pool' : 'pools'} · ${r.settled === 0 ? '0 settled' : `${r.won} of ${r.settled} won`}`;
  return (
    <li style={{ display: 'grid', gridTemplateColumns: compact ? '40px minmax(0, 1fr) auto' : '56px minmax(0, 1fr) 140px 180px', gap: 12, alignItems: 'center', padding: '12px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
      <span style={{ ...mono, fontSize: 13, color: 'var(--dim)' }}>{place}</span>
      <span style={{ minWidth: 0 }}>
        <Link href={profileHref(r.actor)} style={{ ...display, fontSize: 16, color: 'inherit', textDecoration: 'none', overflowWrap: 'anywhere' }}>
          {r.displayName?.trim() || formatAddress(r.actor)}
        </Link>
        {prize !== undefined && <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', marginLeft: 8 }}>${prize}</span>}
        {compact && <span style={{ display: 'block', ...mono, fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{rate}</span>}
      </span>
      <span style={{ ...display, fontSize: 16, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: TONE_FG[profit.tone] }}>{profit.text}</span>
      {!compact && <span style={{ ...mono, fontSize: 12, textAlign: 'right', color: 'var(--dim)' }}>{rate}</span>}
    </li>
  );
}
