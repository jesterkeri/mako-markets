'use client';

// 9a "YES share of the pool · SINCE OPENING": the pool's YES share after each bet, from /api/pools/[id]/history (the
// Envio indexer), ending at the share the contract holds now. The line is drawn in yellow with the design's 75/50/25%
// guides; the tag on the right is the current share. The history is drawn only when the indexer's totals equal the
// contract's: while the indexer is behind (a bet it has not seen yet) the chart says it is catching up and checks again
// every 10 seconds, because drawing the older history to "now" would show the share as it was, not as it is.

/// The indexer's totals equal the contract's, so its bets are all the bets there are.
export function historyMatches(h: { indexedYes: string; indexedNo: string }, chainYes: bigint, chainNo: bigint): boolean {
  return /^\d+$/.test(h.indexedYes) && /^\d+$/.test(h.indexedNo) && BigInt(h.indexedYes) === chainYes && BigInt(h.indexedNo) === chainNo;
}

import { useQuery } from '@tanstack/react-query';

import { shareGeometry } from '@/lib/chart-geometry';

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

type History = { points: { t: number; yesBps: number }[]; bets: number; indexedYes: string; indexedNo: string };

async function fetchHistory(id: string): Promise<History> {
  const res = await fetch(`/api/pools/${id}/history`);
  if (!res.ok) throw new Error(`history ${res.status}`);
  const body = (await res.json()) as Partial<History>;
  if (!Array.isArray(body.points) || typeof body.indexedYes !== 'string' || typeof body.indexedNo !== 'string') throw new Error('history answer');
  return { points: body.points, bets: Number(body.bets), indexedYes: body.indexedYes, indexedNo: body.indexedNo };
}

const WEEKDAY = (s: number) => new Date(s * 1000).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
const HHMM = (s: number) => new Date(s * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/// Five labels from opening to now: weekdays for a pool open two days or more, otherwise clock times; the last is NOW.
export function shareTicks(start: number, now: number): string[] {
  const span = Math.max(1, now - start);
  const fmt = span >= 2 * 86400 ? WEEKDAY : HHMM;
  return [0, 0.25, 0.5, 0.75].map((f) => fmt(start + span * f)).concat('NOW');
}

/// YES as basis points of the pool's current totals, or null for an empty pool.
export function chainShareBps(yes: bigint, no: bigint): number | null {
  const total = yes + no;
  return total === 0n ? null : Number((yes * 10000n) / total);
}

export function YesShareChart({ marketId, openedAt, now, chainYes, chainNo, height = 190 }: { marketId: bigint; openedAt: number; now: number; chainYes: bigint; chainNo: bigint; height?: number }) {
  const q = useQuery({
    queryKey: ['pool-history', marketId.toString()],
    queryFn: () => fetchHistory(marketId.toString()),
    // Faster while the indexer is behind the contract, so the chart appears as soon as it has caught up.
    refetchInterval: (query) => (query.state.data && !historyMatches(query.state.data, chainYes, chainNo) ? 10_000 : 60_000),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
  });
  const nowShare = chainShareBps(chainYes, chainNo);
  const matches = q.data ? historyMatches(q.data, chainYes, chainNo) : false;
  // Only a history that adds up to the contract's totals is drawn; it then runs on to now at the same share.
  const points = q.data && matches && nowShare !== null ? [...q.data.points, { t: Math.max(now, q.data.points.at(-1)?.t ?? now), yesBps: nowShare }] : [];
  const g = shareGeometry(points, openedAt, now);
  const pct = (bps: number) => `${Math.floor(bps / 100)}%`;

  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px 10px' }}>
        <span style={{ ...display, fontSize: 20, letterSpacing: '-0.02em' }}>YES share of the pool</span>
        <span style={{ ...mono, fontSize: 10, color: 'var(--dim)' }}>
          SINCE OPENING · {WEEKDAY(openedAt)} {HHMM(openedAt)}
        </span>
      </div>
      <div style={{ position: 'relative', height }}>
        {g ? (
          <>
            <svg viewBox="0 0 600 160" preserveAspectRatio="none" role="img" aria-label={`YES share since opening, now ${pct(g.lastBps)}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}>
              <path d="M0 40H600M0 120H600" stroke="currentColor" strokeOpacity=".06" vectorEffect="non-scaling-stroke" />
              <path d="M0 80H600" stroke="currentColor" strokeOpacity=".22" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
              <path d={g.area} fill="var(--mako-signal)" fillOpacity={0.12} />
              <path d={g.line} fill="none" stroke="var(--mako-signal)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
              <path d={g.line} fill="none" stroke="var(--edge-c)" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
            </svg>
            <span aria-hidden="true" style={{ position: 'absolute', right: 0, top: `${g.lastTopPct}%`, transform: 'translate(0,-50%)', height: 20, display: 'flex', alignItems: 'center', padding: '0 7px', borderRadius: 6, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...mono, fontSize: 11, fontWeight: 700 }}>
              YES&nbsp;{pct(g.lastBps)}
            </span>
            <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, transform: 'translateY(-2px)', ...mono, fontSize: 10, color: 'var(--dim)' }}>75%</span>
            <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-130%)', ...mono, fontSize: 10, color: 'var(--dim)' }}>50%</span>
            <span aria-hidden="true" style={{ position: 'absolute', left: 0, bottom: 0, transform: 'translateY(2px)', ...mono, fontSize: 10, color: 'var(--dim)' }}>25%</span>
          </>
        ) : (
          <div role="status" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, borderRadius: 12, background: 'var(--raise)', ...mono, fontSize: 12, color: 'var(--dim)' }}>
            {nowShare === null
              ? 'No bets yet. The chart starts with the first bet.'
              : q.isError
                ? 'Share history unavailable right now.'
                : q.data && !matches
                  ? 'Catching up with the latest bet…'
                  : 'Loading share history…'}
          </div>
        )}
      </div>
      {g && (
        <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px 0', ...mono, fontSize: 10, color: 'var(--dim)' }}>
          {shareTicks(openedAt, now).map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
