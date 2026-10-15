'use client';

import Link from 'next/link';

import { closeTimeOf, commentary, entryCloseOf, mmss, phaseAt, V1_ASSET, type Round, type RoundPhase } from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { roundsContract, useRounds } from '@/lib/use-rounds';

// Home's Rounds pieces (2a), from the live contract. Until Rounds is live, or while it can't be read, each one
// renders the caller's not-open fallback, so Home never shows an empty or broken round.

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const clock = (unixS: number) => new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

type Featured = { round: Round; phase: RoundPhase } | null;

/// The round Home leads with: the soonest still open for predictions, else the one live now.
function featuredOf(rounds: Round[], now: number): Featured {
  const by = (p: RoundPhase[]) =>
    rounds
      .map((r) => ({ round: r, phase: phaseAt(r, now) }))
      .filter((x) => p.includes(x.phase))
      .sort((a, b) => a.round.startTime - b.round.startTime)[0] ?? null;
  return by(['open']) ?? by(['starting', 'live']);
}

function useHomeRounds(): { rounds: Round[]; now: number } | null {
  const state = useRounds();
  const now = useLiveNowSec();
  if (state.kind !== 'ready' || now === null) return null;
  return { rounds: state.rounds, now };
}

function lineFor(f: NonNullable<Featured>, now: number): { label: string; value: string } {
  const r = f.round;
  if (f.phase === 'open') return { label: 'Predictions close in', value: mmss(entryCloseOf(r) - now) };
  if (f.phase === 'starting') return { label: 'Starts in', value: mmss(r.startTime - now) };
  return { label: 'Result in', value: mmss(closeTimeOf(r) - now) };
}

/// Desktop: the strip under the header.
/// Rounds not configured: the fallback, with no chain reads at all.
export function HomeRoundsBand({ fallback }: { fallback: React.ReactNode }) {
  return roundsContract ? <HomeRoundsBandLive fallback={fallback} /> : <>{fallback}</>;
}

function HomeRoundsBandLive({ fallback }: { fallback: React.ReactNode }) {
  const data = useHomeRounds();
  if (!data) return <>{fallback}</>;
  const f = featuredOf(data.rounds, data.now);
  const button: React.CSSProperties = { height: 50, display: 'inline-flex', alignItems: 'center', padding: '0 22px', borderRadius: 9999, ...display, fontSize: 16, whiteSpace: 'nowrap', textDecoration: 'none' };
  return (
    <section aria-labelledby="home-rounds-title" style={{ display: 'flex', alignItems: 'center', gap: 26, padding: '18px 22px', borderTop: '1px solid var(--line)', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--dim)' }}>
          {f ? (f.phase === 'open' ? 'Next round · open for predictions' : 'Round live now') : 'Rounds'}
        </div>
        <h2 id="home-rounds-title" style={{ margin: '6px 0 0', ...display, fontSize: 44, lineHeight: 1, letterSpacing: '-0.03em' }}>
          {f ? `${V1_ASSET.symbol} up or down by ${clock(closeTimeOf(f.round))}?` : 'No round is open right now'}
        </h2>
        <p style={{ margin: '10px 0 0', fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' }}>
          {f ? commentary(f.round, data.now) : 'Rounds run on a schedule, a few a day. The next one appears as soon as it is scheduled.'}
        </p>
      </div>
      {f && (
        <div style={{ flex: 'none', textAlign: 'right' }}>
          <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase' }}>{lineFor(f, data.now).label}</div>
          <div style={{ ...display, fontSize: 48, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{lineFor(f, data.now).value}</div>
        </div>
      )}
      <Link href={f ? `/rounds/${f.round.id.toString()}` : '/rounds'} className="mk-press96" style={{ ...button, flex: 'none', background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
        {f ? (f.phase === 'open' ? 'Predict' : 'Watch') : 'See rounds'}
      </Link>
    </section>
  );
}
