'use client';

// The design's candle chart (2a/5a "BTC/USD NOW"): yellow up and red down candles, prices down the right edge, the
// last price tagged, times along the bottom. Candles come from /api/charts (Coinbase), which is a reference picture
// of the market: the caption says so, and pools and rounds settle on their own sources.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { candleGeometry } from '@/lib/chart-geometry';
import type { Candle, Timeframe } from '@/types/chart';

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };

const TF_LABEL: Record<Timeframe, string> = { '1m': '1M', '15m': '15M', '1h': '1H', '2h': '2H', '4h': '4H', '1d': '1D' };
const REFETCH_MS: Record<Timeframe, number> = { '1m': 30_000, '15m': 120_000, '1h': 300_000, '2h': 300_000, '4h': 600_000, '1d': 1_800_000 };

function timeLabel(tf: Timeframe) {
  return (ms: number) => {
    const d = new Date(ms);
    if (tf === '1d') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
}

async function fetchCandles(symbol: string, tf: Timeframe): Promise<Candle[]> {
  const res = await fetch(`/api/charts?s=${encodeURIComponent(symbol)}&tf=${tf}`);
  if (!res.ok) throw new Error(`charts ${res.status}`);
  const body = (await res.json()) as { candles?: Candle[] };
  if (!Array.isArray(body.candles)) throw new Error('charts answer');
  return body.candles;
}

export function PriceCandles({
  symbol,
  pair,
  timeframes,
  initial,
  maxBars = 60,
  height = 190,
}: {
  /// The chart-list symbol ("BTC").
  symbol: string;
  /// How the pair is written in the header ("BTC/USD").
  pair: string;
  timeframes: readonly Timeframe[];
  initial: Timeframe;
  maxBars?: number;
  height?: number;
}) {
  const [tf, setTf] = useState<Timeframe>(initial);
  const q = useQuery({
    queryKey: ['price-candles', symbol, tf],
    queryFn: () => fetchCandles(symbol, tf),
    refetchInterval: REFETCH_MS[tf],
    refetchIntervalInBackground: false,
    staleTime: REFETCH_MS[tf] / 2,
  });
  const g = q.data ? candleGeometry(q.data, maxBars, timeLabel(tf)) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 4px 8px', flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap', ...mono, fontSize: 10, color: 'var(--dim)' }}>
          <span style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>
            {pair} · {TF_LABEL[tf]}
          </span>
          {g?.ohlc.map((o) => (
            <span key={o.k}>
              {o.k} <span style={{ color: g.last.up ? 'var(--up-text)' : 'var(--mako-red)' }}>{o.v}</span>
            </span>
          ))}
        </span>
        {timeframes.length > 1 && (
          <div role="group" aria-label="Chart timeframe" style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
            {timeframes.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={t === tf}
                onClick={() => setTf(t)}
                className="mk-press96"
                style={{ height: 26, padding: '0 10px', borderRadius: 9999, ...mono, fontSize: 11, fontWeight: 700, background: t === tf ? 'var(--mako-canvas-fg)' : 'transparent', color: t === tf ? 'var(--mako-canvas)' : 'var(--dim)' }}
              >
                {TF_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ position: 'relative', height }}>
        {g ? (
          <>
            <svg viewBox="0 0 600 170" preserveAspectRatio="none" aria-label={`${pair} price chart, last ${g.last.label}`} role="img" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: height - 20, display: 'block' }}>
              <path d="M0 42H540M0 84H540M0 126H540M135 0V170M270 0V170M405 0V170" stroke="currentColor" strokeOpacity=".06" vectorEffect="non-scaling-stroke" />
              <path d="M540 0V170M0 169.5H600" stroke="currentColor" strokeOpacity=".12" vectorEffect="non-scaling-stroke" />
              <path d={`M0 ${g.last.y}H540`} stroke="currentColor" strokeOpacity=".35" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
              <path d={g.upWicks} stroke="var(--wick-up)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={g.dnWicks} stroke="var(--wick-dn)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={g.upBodies} fill="var(--mako-signal)" stroke="var(--edge-c)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <path d={g.dnBodies} fill="var(--mako-red)" stroke="var(--edge-c)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            </svg>
            {g.scale.map((p) => (
              <span key={p.label} aria-hidden="true" style={{ position: 'absolute', right: 8, top: `calc(${p.topPct / 100} * ${height - 20}px)`, transform: 'translateY(-50%)', ...mono, fontSize: 10, color: 'var(--dim)' }}>
                {p.label}
              </span>
            ))}
            <span aria-hidden="true" style={{ position: 'absolute', right: 4, top: `calc(${g.last.topPct / 100} * ${height - 20}px)`, transform: 'translateY(-50%)', padding: '2px 5px', borderRadius: 4, background: g.last.up ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', ...mono, fontSize: 10, fontWeight: 700, boxShadow: 'var(--edge)' }}>
              {g.last.label}
            </span>
            {g.times.map((t) => (
              <span key={`${t.leftPct}`} aria-hidden="true" style={{ position: 'absolute', bottom: 2, left: `${t.leftPct}%`, transform: 'translateX(-50%)', ...mono, fontSize: 10, color: 'var(--dim)' }}>
                {t.label}
              </span>
            ))}
          </>
        ) : (
          <div role="status" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'var(--raise)', ...mono, fontSize: 12, color: 'var(--dim)' }}>
            {q.isError ? 'Price chart unavailable right now.' : q.data ? 'No price data yet.' : 'Loading price chart…'}
          </div>
        )}
      </div>
      <div style={{ ...mono, fontSize: 10, color: 'var(--dim)', padding: '6px 4px 0' }}>REFERENCE PRICE FROM COINBASE · NOT THE SETTLEMENT SOURCE</div>
    </div>
  );
}
