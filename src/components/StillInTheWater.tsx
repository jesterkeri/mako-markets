'use client';

import Link from 'next/link';

import { formatCountdown } from '@/lib/countdown';
import { useMarkets } from '@/lib/hooks';
import { openPools, poolMeta } from '@/lib/pool-display';
import { useLiveNowSec } from '@/lib/use-live-clock';

// Rounds join this list once MakoRoundsV1 is live; until then it shows real open pools only, never a made-up
// round.
function usePoolsStillOpen(limit: number) {
  const { markets, count, isLoading, isError, refetch } = useMarkets();
  const now = useLiveNowSec();
  const pools = now === null ? [] : openPools(markets, now).slice(0, limit);
  // A failed read, or fewer markets than the count (some reads failed), is unknown, never "nothing is open": the pool
  // closing first could be the one missing.
  const failed = isError || (!isLoading && markets.length < count);
  return { pools, now, loading: !failed && (isLoading || now === null), failed, retry: refetch };
}

function Unreadable({ onRetry, size }: { onRetry: () => void; size: number }) {
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: size, color: 'var(--dim)' }}>
      <span>Open pools can&apos;t be read from Monad right now.</span>
      <button type="button" onClick={onRetry} className="mk-press97" style={{ height: 32, padding: '0 14px', borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', fontWeight: 800, fontSize: 13 }}>
        Try again
      </button>
    </div>
  );
}

const poolPill: React.CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  borderRadius: 9999,
  background: 'var(--raise2)',
  color: 'var(--mako-canvas-fg)',
  fontWeight: 800,
};

/// "Still in the water" (7a): the way back from a dead end, desktop.
export function StillInTheWaterDesktop() {
  const { pools, now, loading, failed, retry } = usePoolsStillOpen(3);
  return (
    <div style={{ marginTop: 44, padding: '0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', paddingBottom: 6, boxShadow: 'inset 0 -1px 0 var(--line)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '-0.02em' }}>Still in the water</span>
          <span style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)' }}>LIVE NOW</span>
        </div>
        <Link href="/" style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15, color: 'var(--mako-canvas-fg)', textDecoration: 'none' }}>
          Home →
        </Link>
      </div>
      {failed ? (
        <div style={{ padding: '18px 0' }}>
          <Unreadable onRetry={retry} size={14} />
        </div>
      ) : !loading && pools.length === 0 ? (
        <div style={{ padding: '18px 0', fontSize: 14, color: 'var(--dim)' }}>Nothing is open right now.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', columnGap: 32 }}>
          {pools.map((m) => (
            <Link
              key={m.id.toString()}
              href={`/pools/${m.id}`}
              className="mk-press97"
              style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 0', boxShadow: 'inset 0 -1px 0 var(--line)', textAlign: 'left', color: 'var(--mako-canvas-fg)', textDecoration: 'none' }}
            >
              <span style={{ ...poolPill, height: 24, padding: '0 10px', fontSize: 10, letterSpacing: '0.12em' }}>POOL</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.question}</span>
                <span style={{ display: 'block', fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{poolMeta(m)}</span>
              </span>
              <span style={{ flex: 'none', fontFamily: 'var(--mako-font-mono)', fontSize: 15, fontWeight: 700 }}>
                {now === null ? '' : formatCountdown(Number(m.bettingCloseTime) - now)}
              </span>
              <span aria-hidden="true" style={{ flex: 'none', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 18 }}>→</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/// "Still in the water" (7a), mobile.
export function StillInTheWaterMobile() {
  const { pools, now, loading, failed, retry } = usePoolsStillOpen(2);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 20px 12px' }}>
        <span style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em' }}>Still in the water</span>
      </div>
      {failed ? (
        <div style={{ padding: '0 20px' }}>
          <Unreadable onRetry={retry} size={15} />
        </div>
      ) : !loading && pools.length === 0 ? (
        <div style={{ padding: '0 20px', fontSize: 15, color: 'var(--dim)' }}>Nothing is open right now.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px' }}>
          {pools.map((m) => (
            <Link
              key={m.id.toString()}
              href={`/pools/${m.id}`}
              className="m3-press"
              style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 24, background: 'var(--raise)', padding: '12px 12px 12px 16px', color: 'var(--mako-canvas-fg)', textDecoration: 'none' }}
            >
              <span style={{ ...poolPill, height: 26, padding: '0 11px', fontSize: 11, letterSpacing: '0.06em' }}>POOL</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.question}</div>
                <div style={{ fontSize: 13, color: 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{poolMeta(m)}</div>
              </div>
              <span style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
                {now === null ? '' : formatCountdown(Number(m.bettingCloseTime) - now)}
              </span>
              <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 9999, background: 'var(--mako-canvas)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7.5 16.5l9-9M9.5 7.5h7v7" />
                </svg>
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
