// ----------------------------------------------------------------------------
// src/components/MarketChart.tsx
//
// Detail-page chart slot. Props are the dual-symbol pair from
// `marketToChartConfig()`. Renders a `<TimeframeSelector>` over a
// lazy-loaded `<CandlestickChart>` fed by `/api/charts`.
//
// Commodities (XAU/XAG/XPT) are daily-only (Stooq has no intraday
// on free tier). All other classes get 15m/1h/2h/4h/1d. The
// commodity caveat banner is rendered under the chart so users
// understand the granularity asymmetry.
//
// Polish r2: theme-aware shadow (shadow-brutal-lg flips with theme),
// slight left tilt on the collapsed card, expand-to-fullscreen icon
// button + overlay (ESC closes, no tilt or shadow in expanded form).
// ----------------------------------------------------------------------------

'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

import { CandlestickChart } from '@/components/chart/CandlestickChart';
import { TimeframeSelector } from '@/components/chart/TimeframeSelector';
import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';

interface Props {
  oracleSymbol: string;
  assetClass: ChartAssetClass;
}

const TIMEFRAMES_BY_CLASS: Record<ChartAssetClass, readonly Timeframe[]> = {
  CRYPTO:      ['15m', '1h', '2h', '4h', '1d'],
  FOREX:       ['15m', '1h', '2h', '4h', '1d'],
  STOCKS:      ['15m', '1h', '2h', '4h', '1d'],
  // Yahoo Finance futures feed supports 15m / 60m / 1d natively.
  // 2h + 4h would need aggregation we don't do, so they're hidden.
  COMMODITIES: ['15m', '1h', '1d'],
};

// Default to the most-useful timeframe for each class.
function defaultTimeframe(assetClass: ChartAssetClass): Timeframe {
  return '1h';
}

const CHART_HEIGHT = 350;

interface ChartsResponse {
  candles: Candle[];
}

export function MarketChart({ oracleSymbol, assetClass }: Props) {
  const options = TIMEFRAMES_BY_CLASS[assetClass];
  const [tf, setTf] = useState<Timeframe>(defaultTimeframe(assetClass));
  const [expanded, setExpanded] = useState(false);

  // Render-phase reset on assetClass change. App Router keeps the
  // component mounted across `/market/[id]` navigations, so a `tf`
  // left over from a CRYPTO market (e.g. '1h') would carry into a
  // subsequent COMMODITIES market (which only supports '1d') and
  // force a 400 timeframe_not_supported from the route.
  const [prevAssetClass, setPrevAssetClass] = useState(assetClass);
  if (assetClass !== prevAssetClass) {
    setPrevAssetClass(assetClass);
    setTf(defaultTimeframe(assetClass));
  }

  // ESC closes the expanded overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // Lock body scroll while overlay open.
  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<ChartsResponse>({
    queryKey: ['charts', oracleSymbol, tf],
    queryFn: async () => {
      const url = `/api/charts?s=${encodeURIComponent(oracleSymbol)}&tf=${tf}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`charts route ${res.status}`);
      return (await res.json()) as ChartsResponse;
    },
    staleTime: 120_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // shadow-brutal-lg uses var(--mako-shadow) which flips with theme
  // (light: ink-black, dark: paper-cream) so the drop shadow stays
  // visible against the canvas in both modes. Tilt is a barely
  // perceptible -1deg per Joshua's "very tiny bit" feedback.
  const cardClass =
    'bg-paper border-2 border-ink rounded-2xl shadow-brutal-lg overflow-hidden';

  if (isLoading) {
    return (
      <div
        className={`${cardClass} animate-pulse rotate-[-1deg]`}
        style={{ height: CHART_HEIGHT + 64 }}
        aria-label="Loading chart"
      />
    );
  }

  if (error || !data?.candles?.length) {
    return (
      <div
        className={`${cardClass} flex flex-col items-center justify-center gap-4 p-8 min-h-[200px] rotate-[-1deg]`}
      >
        <div className="mako-label text-sm">CHART UNAVAILABLE</div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="mako-button mako-label text-xs disabled:opacity-50"
        >
          {isFetching ? 'RETRYING' : 'RETRY'}
        </button>
      </div>
    );
  }

  const header = (
    <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-b-2 border-ink">
      <span className="mako-mono text-xs tracking-widest text-muted">
        {oracleSymbol}
      </span>
      <div className="flex items-center gap-2">
        <TimeframeSelector value={tf} onChange={setTf} options={options} />
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? 'Collapse chart' : 'Expand chart'}
          className="inline-flex items-center justify-center w-8 h-8 rounded-full border-2 border-ink bg-paper hover:bg-ink hover:text-paper transition-colors"
        >
          {expanded ? (
            // Collapse (X)
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            // Expand (arrows pointing outward)
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );

  // Commodities now have intraday via Yahoo futures, so the old
  // "DAILY CANDLES ONLY" caveat doesn't apply. Keeping the slot
  // null and reserved in case we add per-class disclosures later.
  const commoditiesFooter = null;

  if (expanded) {
    // Portal to document.body so the overlay escapes every parent
    // stacking context — sidebar (z-40+), sticky headers, mobile
    // betsheet wrapper, etc. all live deeper in the tree. Without
    // the portal `fixed inset-0` is still trapped behind a 50px
    // sidebar on `/market/[id]`. z-[200] beats anything mako sets.
    const overlay = (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6 bg-ink/80 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded price chart"
        onClick={(e) => {
          if (e.target === e.currentTarget) setExpanded(false);
        }}
      >
        <div
          className={`${cardClass} w-full max-w-[1600px] flex flex-col`}
          style={{ height: 'calc(100vh - 4rem)' }}
        >
          {header}
          {/* Explicit pixel height on the chart body — `flex-1` alone
              gives lightweight-charts a 0-height container because its
              clientHeight read can't resolve against an auto-sized flex
              parent. Using calc relative to the overlay height ensures
              the canvas has a concrete number to size against. The
              80px subtracted is header (~52px) + breathing room +
              optional commodities footer. */}
          <div
            className="flex-1"
            style={{ position: 'relative', minHeight: 0, height: 'calc(100vh - 4rem - 80px)' }}
          >
            <CandlestickChart
              candles={data.candles}
              instrument={oracleSymbol}
              assetClass={assetClass}
              timeframe={tf}
              height={undefined}
            />
          </div>
          {commoditiesFooter}
        </div>
      </div>
    );

    return (
      <>
        {/* Inline placeholder so the page layout doesn't collapse while
            the chart is lifted into the overlay. Matches the collapsed
            card's outline so the slot stays reserved. */}
        <div
          className="bg-paper/30 border-2 border-dashed border-ink/30 rounded-2xl flex items-center justify-center"
          style={{ height: CHART_HEIGHT + 64 }}
          aria-hidden
        >
          <span className="mako-label text-muted text-xs">CHART EXPANDED · PRESS ESC TO CLOSE</span>
        </div>
        {typeof document !== 'undefined' ? createPortal(overlay, document.body) : null}
      </>
    );
  }

  return (
    <div className={`${cardClass} rotate-[-1deg]`}>
      {header}
      <div style={{ height: CHART_HEIGHT, position: 'relative' }}>
        <CandlestickChart
          candles={data.candles}
          instrument={oracleSymbol}
          assetClass={assetClass}
          timeframe={tf}
          height={CHART_HEIGHT}
        />
      </div>
      {commoditiesFooter}
    </div>
  );
}
