import type { Metadata } from 'next';
import { COMPETITION_COPY, competitionStatus, PRIZES } from '@/lib/competition/config';
import { getCompetitionStandings, type CompetitionStandings } from '@/lib/competition/standings';

import { StandingRow as Row } from './StandingRow';

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

function Competition({ standings, compact }: { standings: CompetitionStandings | null; compact: boolean }) {
  return (
    <section aria-label={COMPETITION_COPY.title} style={{ padding: compact ? '20px 16px' : '32px 40px', maxWidth: 880, color: 'var(--mako-canvas-fg)' }}>
      <h1 style={{ ...display, fontSize: compact ? 30 : 48, letterSpacing: '-0.03em', margin: 0 }}>{COMPETITION_COPY.title}</h1>
      <div role="status" style={{ ...mono, fontSize: 13, marginTop: 10, color: 'var(--dim)' }}>
        {competitionStatus()}
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
