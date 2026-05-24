// ----------------------------------------------------------------------------
// src/components/MarketChart.tsx
//
// Detail-page chart slot. Props are the dual-symbol pair from
// `marketToChartConfig()`. Renders a `<TimeframeSelector>` over a
// lazy-loaded `<CandlestickChart>` fed by `/api/charts`.
//
// Commodities (XAU/XAG/XPT) are daily-only (Stooq has no intraday
// on free tier). All other classes get 15m/1h/4h/1d. The
// commodity caveat banner is rendered under the chart so users
// understand the granularity asymmetry.
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

'use client';

import { useState } from 'react';
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
  CRYPTO:      ['15m', '1h', '4h', '1d'],
  FOREX:       ['15m', '1h', '4h', '1d'],
  STOCKS:      ['15m', '1h', '4h', '1d'],
  COMMODITIES: ['1d'],
};

// Default to the most-useful timeframe for each class. Commodities
// only have '1d'; everything else opens at '1h'.
function defaultTimeframe(assetClass: ChartAssetClass): Timeframe {
  return assetClass === 'COMMODITIES' ? '1d' : '1h';
}

const CHART_HEIGHT = 350;

interface ChartsResponse {
  candles: Candle[];
}

export function MarketChart({ oracleSymbol, assetClass }: Props) {
  const options = TIMEFRAMES_BY_CLASS[assetClass];
  const [tf, setTf] = useState<Timeframe>(defaultTimeframe(assetClass));

  // Render-phase reset on assetClass change. App Router keeps the
  // component mounted across `/market/[id]` navigations, so a `tf`
  // left over from a CRYPTO market (e.g. '1h') would carry into a
  // subsequent COMMODITIES market (which only supports '1d') and
  // force a 400 timeframe_not_supported from the route. Same
  // pattern used elsewhere in the repo for prop-driven resets
  // (see CreatePrivateClient.tsx render-phase prev-state pattern).
  const [prevAssetClass, setPrevAssetClass] = useState(assetClass);
  if (assetClass !== prevAssetClass) {
    setPrevAssetClass(assetClass);
    setTf(defaultTimeframe(assetClass));
  }

  const { data, isLoading, error, refetch, isFetching } = useQuery<ChartsResponse>({
    queryKey: ['charts', oracleSymbol, tf],
    queryFn: async () => {
      const url = `/api/charts?s=${encodeURIComponent(oracleSymbol)}&tf=${tf}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`charts route ${res.status}`);
      return (await res.json()) as ChartsResponse;
    },
    staleTime: 120_000,           // matches 15m TTL floor on the route
    refetchOnWindowFocus: false,  // testnet — chart isn't trading-grade
    retry: 1,
  });

  // Shared neobrutal card chrome. Shadow + corner radius match the
  // YES/NO probability bar and the AdminPanel sitting on the same page.
  const cardClass =
    'bg-paper border-2 border-ink rounded-2xl shadow-[8px_8px_0_0_var(--mako-ink)] overflow-hidden';

  if (isLoading) {
    return (
      <div
        className={`${cardClass} animate-pulse`}
        style={{ height: CHART_HEIGHT + 64 }}
        aria-label="Loading chart"
      />
    );
  }

  if (error || !data?.candles?.length) {
    return (
      <div
        className={`${cardClass} flex flex-col items-center justify-center gap-4 p-8 min-h-[200px]`}
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

  return (
    <div className={cardClass}>
      <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-b-2 border-ink">
        <span className="mako-mono text-xs tracking-widest text-muted">
          {oracleSymbol}
        </span>
        <TimeframeSelector value={tf} onChange={setTf} options={options} />
      </div>
      <div style={{ height: CHART_HEIGHT, position: 'relative' }}>
        <CandlestickChart
          candles={data.candles}
          instrument={oracleSymbol}
          assetClass={assetClass}
          timeframe={tf}
          height={CHART_HEIGHT}
        />
      </div>
      {assetClass === 'COMMODITIES' && (
        <div className="mako-label text-[10px] px-4 py-2 border-t-2 border-ink bg-signal text-ink">
          DAILY CANDLES ONLY · INTRADAY PENDING PAID DATA TIER
        </div>
      )}
    </div>
  );
}
