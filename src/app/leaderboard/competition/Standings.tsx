import { COMPETITION_COPY, PRIZES } from '@/lib/competition/config';
import type { CompetitionStandings } from '@/lib/competition/standings';

import { StandingRow as Row } from './StandingRow';

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

/// Everyone in the competition: the ranked players with the prize places, then the entrants not ranked yet. The
/// competition page and the leaderboard's Competition tab show the same lists (Joshua 2026-10-27: the tab shows the
/// people in it, without opening the page).
export function Standings({ standings, compact }: { standings: CompetitionStandings; compact: boolean }) {
  const h2: React.CSSProperties = { ...display, fontSize: compact ? 20 : 24, margin: '28px 0 10px' };
  return (
    <>
      <h2 style={h2}>{COMPETITION_COPY.ranked}</h2>
      {standings.ranked.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--dim)' }}>{COMPETITION_COPY.noneRanked}</p>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {standings.ranked.map((r, i) => (
            <Row key={r.actor} r={r} place={`#${i + 1}`} prize={PRIZES[i]} compact={compact} />
          ))}
        </ol>
      )}
      <h2 style={h2}>{COMPETITION_COPY.unranked}</h2>
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
  );
}
