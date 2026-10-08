'use client';

// The full chart as a page of its own (Joshua, 2026-10-08: opening the chart is a page, not a pop-up): a way back,
// the question as the title, and the chart filling the rest of the screen with every tool (timeframes, zoom,
// indicators, drawing). The browser's back button returns to the pool or round.
import Link from 'next/link';

import { MarketChart } from '@/components/MarketChart';
import type { Timeframe } from '@/types/chart';

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

export function ChartPage({
  backHref,
  backLabel,
  title,
  symbol,
  pair,
  timeframes,
  initialTimeframe,
}: {
  backHref: string;
  backLabel: string;
  title: string | null;
  symbol: string;
  pair: string;
  timeframes?: readonly Timeframe[];
  initialTimeframe?: Timeframe;
}) {
  return (
    <div className="mk-desk-frame" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 12px 16px', height: 'calc(100dvh - 72px)', minHeight: 480 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, minWidth: 0 }}>
        <Link href={backHref} style={{ ...mono, fontSize: 12, color: 'var(--dim)', textDecoration: 'none', flex: 'none' }}>
          ← {backLabel}
        </Link>
        {title && (
          <h1 style={{ margin: 0, ...display, fontSize: 22, lineHeight: 1.15, letterSpacing: '-0.02em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</h1>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <MarketChart oracleSymbol={symbol} assetClass="CRYPTO" pair={pair} timeframes={timeframes} initialTimeframe={initialTimeframe} page />
      </div>
    </div>
  );
}
