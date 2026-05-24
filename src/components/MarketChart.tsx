// ----------------------------------------------------------------------------
// src/components/MarketChart.tsx
//
// Detail-page chart slot. Props are the dual-symbol pair from
// `marketToChartConfig()`. Renders a `<TimeframeSelector>` over a
// lazy-loaded `<CandlestickChart>` fed by `/api/charts`.
//
// Polish r6: header strip now hosts an "INDICATORS" dropdown
// (Volume / MA20 / EMA50 toggles) and a zoom cluster
// (zoom in / out / fit). Chart instance is reached via a ref +
// useImperativeHandle so the buttons can call timeScale methods
// without lifting all chart internals into this component.
//
// Drawing tools (trendlines / fib) are NOT included — they need
// a library swap. Joshua's separate decision.
// ----------------------------------------------------------------------------

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

import { CandlestickChart } from '@/components/chart/CandlestickChart';
import { TimeframeSelector } from '@/components/chart/TimeframeSelector';
import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';
import type { ChartInnerHandle } from '@/components/chart/ChartInner';

interface Props {
  oracleSymbol: string;
  assetClass: ChartAssetClass;
}

const TIMEFRAMES_BY_CLASS: Record<ChartAssetClass, readonly Timeframe[]> = {
  CRYPTO:      ['15m', '1h', '2h', '4h', '1d'],
  FOREX:       ['15m', '1h', '2h', '4h', '1d'],
  STOCKS:      ['15m', '1h', '2h', '4h', '1d'],
  COMMODITIES: ['15m', '1h', '1d'],
};

function defaultTimeframe(_assetClass: ChartAssetClass): Timeframe {
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
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showEMA50, setShowEMA50] = useState(false);
  const chartRef = useRef<ChartInnerHandle>(null);
  const toolsRef = useRef<HTMLDivElement>(null);

  // Render-phase reset on assetClass change.
  const [prevAssetClass, setPrevAssetClass] = useState(assetClass);
  if (assetClass !== prevAssetClass) {
    setPrevAssetClass(assetClass);
    setTf(defaultTimeframe(assetClass));
  }

  // ESC closes the expanded overlay AND the tools dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (toolsOpen) setToolsOpen(false);
      else if (expanded) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, toolsOpen]);

  // Close tools dropdown on outside click.
  useEffect(() => {
    if (!toolsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setToolsOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [toolsOpen]);

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

  const iconBtnClass =
    'inline-flex items-center justify-center w-8 h-8 rounded-full border-2 border-ink bg-paper hover:bg-ink hover:text-paper transition-colors';

  const toggleRow = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-4 px-4 py-2 mako-label text-[11px] w-full text-left transition-colors ${
        active ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-ink/5'
      }`}
    >
      <span>{label}</span>
      <span className="inline-flex items-center justify-center w-4 h-4 border-2 border-current rounded-sm">
        {active ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="square">
            <path d="M5 12l5 5 9-9" />
          </svg>
        ) : null}
      </span>
    </button>
  );

  const header = (
    <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-b-2 border-ink relative">
      <span className="mako-mono text-xs tracking-widest text-muted">
        {oracleSymbol}
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        <TimeframeSelector value={tf} onChange={setTf} options={options} />

        {/* Zoom cluster — wired to ChartInner's imperative handle */}
        <div className="inline-flex items-stretch rounded-full border-2 border-ink overflow-hidden bg-paper">
          <button
            type="button"
            onClick={() => chartRef.current?.zoomOut()}
            aria-label="Zoom out"
            className="mako-label text-[14px] leading-none px-3 py-1.5 border-r-2 border-ink bg-paper text-ink hover:bg-ink/5"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.fit()}
            aria-label="Fit chart"
            className="mako-label text-[10px] px-3 py-1.5 border-r-2 border-ink bg-paper text-ink hover:bg-ink/5"
          >
            FIT
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.zoomIn()}
            aria-label="Zoom in"
            className="mako-label text-[14px] leading-none px-3 py-1.5 bg-paper text-ink hover:bg-ink/5"
          >
            +
          </button>
        </div>

        {/* Indicators dropdown */}
        <div ref={toolsRef} className="relative">
          <button
            type="button"
            onClick={() => setToolsOpen((o) => !o)}
            aria-label="Indicators menu"
            aria-expanded={toolsOpen}
            className={`${iconBtnClass} ${toolsOpen ? 'bg-ink text-paper' : ''}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M4 18h6M14 18h6M4 12h2M10 12h10M4 6h12M20 6h0" />
            </svg>
          </button>
          {toolsOpen && (
            <div className="absolute right-0 top-full mt-2 z-30 w-44 bg-paper border-2 border-ink rounded-xl shadow-brutal-sm overflow-hidden">
              <div className="mako-label text-[9px] text-muted px-4 py-2 border-b-2 border-ink bg-surface-elevated">
                INDICATORS
              </div>
              {/* Volume only makes sense for asset classes that have
                  real volume data upstream. FOREX (spot) and the
                  Yahoo COMEX futures we use for COMMODITIES return
                  0 volume from the provider, so the histogram would
                  just be empty bars. */}
              {assetClass !== 'FOREX' &&
                toggleRow('VOLUME', showVolume, () => setShowVolume((v) => !v))}
              {toggleRow('MA (20)', showMA20, () => setShowMA20((v) => !v))}
              {toggleRow('EMA (50)', showEMA50, () => setShowEMA50((v) => !v))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? 'Collapse chart' : 'Expand chart'}
          className={iconBtnClass}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );

  if (expanded) {
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
          <div
            className="flex-1"
            style={{ position: 'relative', minHeight: 0, height: 'calc(100vh - 4rem - 80px)' }}
          >
            <CandlestickChart
              ref={chartRef}
              candles={data.candles}
              instrument={oracleSymbol}
              assetClass={assetClass}
              timeframe={tf}
              height={undefined}
              showVolume={showVolume}
              showMA20={showMA20}
              showEMA50={showEMA50}
            />
          </div>
        </div>
      </div>
    );

    return (
      <>
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
          ref={chartRef}
          candles={data.candles}
          instrument={oracleSymbol}
          assetClass={assetClass}
          timeframe={tf}
          height={CHART_HEIGHT}
          showVolume={showVolume}
          showMA20={showMA20}
          showEMA50={showEMA50}
        />
      </div>
    </div>
  );
}
