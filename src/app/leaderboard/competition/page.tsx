import type { Metadata } from 'next';
import Link from 'next/link';

import { TONE_FG } from '@/app/leaderboard/_components/props';
import { COMPETITION_COPY, COMPETITION_END, COMPETITION_START, PRIZES } from '@/lib/competition/config';
import { getCompetitionStandings, type CompetitionStandings, type StandingRow } from '@/lib/competition/standings';
import { profileHref, signedUsdc2 } from '@/lib/leaderboard/board-view';
import { formatAddress } from '@/lib/user-display';

export const metadata: Metadata = { title: 'Competition · Mako Market Beta' };

// Same reason as the leaderboard: never prerender a stale board. The standings are cached two minutes in the lib.
export const dynamic = 'force-dynamic';

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

/// /leaderboard/competition: the $100 trading competition's rules and standings (REFERRAL_COMPETITION_PLAN r1).
export default async function CompetitionPage() {
  let standings: CompetitionStandings | null = null;
  try {
    standings = await getCompetitionStandings();
  } catch (e) {
    console.error('[competition] standings failed:', e);
  }
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <Competition standings={standings} compact={false} />
      </div>
      <div className="mk-mob mk-m">
        <Competition standings={standings} compact />
      </div>
    </>
  );
}

/// Read per request: the page is force-dynamic, so the clock is this request's.
function status(): string {
  const now = Date.now();
  if (now < COMPETITION_START.getTime()) return COMPETITION_COPY.upcoming;
  return now < COMPETITION_END.getTime() ? COMPETITION_COPY.live : COMPETITION_COPY.final;
}

function Competition({ standings, compact }: { standings: CompetitionStandings | null; compact: boolean }) {
  return (
    <section aria-label={COMPETITION_COPY.title} style={{ padding: compact ? '20px 16px' : '32px 40px', maxWidth: 880, color: 'var(--mako-canvas-fg)' }}>
      <h1 style={{ ...display, fontSize: compact ? 30 : 48, letterSpacing: '-0.03em', margin: 0 }}>{COMPETITION_COPY.title}</h1>
      <div role="status" style={{ ...mono, fontSize: 13, marginTop: 10, color: 'var(--dim)' }}>
        {status()}
      </div>
      <ul style={{ margin: compact ? '16px 0 0' : '20px 0 0', paddingLeft: 20, fontSize: compact ? 14 : 15, lineHeight: 1.5 }}>
        {COMPETITION_COPY.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {standings === null ? (
        <p role="alert" style={{ marginTop: 24, fontSize: 15 }}>
          {COMPETITION_COPY.error}
        </p>
      ) : (
        <>
          <h2 style={{ ...display, fontSize: compact ? 20 : 24, margin: '28px 0 10px' }}>{COMPETITION_COPY.ranked}</h2>
          {standings.ranked.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--dim)' }}>{COMPETITION_COPY.noneRanked}</p>
          ) : (
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {standings.ranked.map((r, i) => (
                <Row key={r.actor} r={r} place={`#${i + 1}`} prize={PRIZES[i]} compact={compact} />
              ))}
            </ol>
          )}
          <h2 style={{ ...display, fontSize: compact ? 20 : 24, margin: '28px 0 10px' }}>{COMPETITION_COPY.unranked}</h2>
          {standings.unranked.length === 0 ? (
            <p style={{ fontSize: 14, color: 'var(--dim)' }}>{COMPETITION_COPY.noneEntered}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {standings.unranked.map((r) => (
                <Row key={r.actor} r={r} place="" compact={compact} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/// One player: place, name (a link to the profile; every entrant is a Mako Market account), profit, win rate.
function Row({ r, place, prize, compact }: { r: StandingRow; place: string; prize?: number; compact: boolean }) {
  const profit = signedUsdc2(BigInt(r.net));
  const rate = r.settled === 0 ? `0 settled` : `${Math.round((r.won / r.settled) * 100)}% · ${r.won} of ${r.settled}`;
  return (
    <li style={{ display: 'grid', gridTemplateColumns: compact ? '40px minmax(0, 1fr) auto' : '56px minmax(0, 1fr) 140px 150px', gap: 12, alignItems: 'center', padding: '12px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
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
