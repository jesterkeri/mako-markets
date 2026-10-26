import Link from 'next/link';

import { COMPETITION_COPY, competitionStatus, PRIZES } from '@/lib/competition/config';
import { getCompetitionStandings, type CompetitionStandings } from '@/lib/competition/standings';

import { StandingRow } from './StandingRow';

// The leaderboard's Competition tab (Joshua 2026-10-26): the competition page's ranked players only, those with
// 2 qualifying referrals and 5 settled pools. Entrants not yet ranked stay on the competition page.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

export async function CompetitionTab({ compact }: { compact: boolean }) {
  let standings: CompetitionStandings | null = null;
  try {
    standings = await getCompetitionStandings();
  } catch (e) {
    console.error('[competition] standings failed:', e);
  }
  return (
    <section aria-label={COMPETITION_COPY.title} style={{ padding: compact ? '16px 16px 0' : '0 4px', color: 'var(--mako-canvas-fg)' }}>
      <div role="status" style={{ ...mono, fontSize: compact ? 12 : 13, color: 'var(--dim)' }}>
        {COMPETITION_COPY.title} · {competitionStatus()}
      </div>
      <p style={{ margin: '8px 0 0', fontSize: compact ? 14 : 15, lineHeight: 1.45 }}>{COMPETITION_COPY.tabNote}</p>
      {standings === null ? (
        <p role="alert" style={{ marginTop: 18, fontSize: 15 }}>
          {COMPETITION_COPY.error}
        </p>
      ) : standings.ranked.length === 0 ? (
        <p style={{ marginTop: 18, fontSize: 14, color: 'var(--dim)' }}>{COMPETITION_COPY.noneRanked}</p>
      ) : (
        <ol style={{ listStyle: 'none', margin: '14px 0 0', padding: 0 }}>
          {standings.ranked.map((r, i) => (
            <StandingRow key={r.actor} r={r} place={`#${i + 1}`} prize={PRIZES[i]} compact={compact} />
          ))}
        </ol>
      )}
      <Link href="/leaderboard/competition" style={{ display: 'inline-block', marginTop: 16, fontSize: compact ? 14 : 15, fontWeight: 700, color: 'inherit', textDecoration: 'underline' }}>
        {COMPETITION_COPY.tabRules}
      </Link>
    </section>
  );
}
