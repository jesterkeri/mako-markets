import Link from 'next/link';
import { cache } from 'react';

import { COMPETITION_COPY, competitionStatus } from '@/lib/competition/config';
import { getCompetitionStandings, type CompetitionStandings } from '@/lib/competition/standings';

import { Standings } from './Standings';

// The leaderboard's Competition tab (Joshua 2026-10-26): the competition page's standings, everyone in it (Joshua
// 2026-10-27: the ranked players, then the entrants not ranked yet), so nobody has to open the page to find themselves.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

/// The page renders the tab twice (desktop and phone): one standings read per request, not two.
const readStandings = cache(getCompetitionStandings);

export async function CompetitionTab({ compact }: { compact: boolean }) {
  let standings: CompetitionStandings | null = null;
  try {
    standings = await readStandings();
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
      ) : (
        <Standings standings={standings} compact={compact} />
      )}
      <Link href="/leaderboard/competition" style={{ display: 'inline-block', marginTop: 16, fontSize: compact ? 14 : 15, fontWeight: 700, color: 'inherit', textDecoration: 'underline' }}>
        {COMPETITION_COPY.tabRules}
      </Link>
    </section>
  );
}
