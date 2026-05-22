// ----------------------------------------------------------------------------
// src/components/chart/CandlestickChart.tsx
//
// Thin wrapper around the heavy `ChartInner` (which pulls in
// `lightweight-charts` ~50KB gzipped). React.lazy + Suspense
// keeps that bundle out of the initial chunk.
//
// Ported from krait `apps/web/src/components/chart/CandlestickChart.tsx`,
// stripped of props we don't use in mako v1 (livePrice / replayMode /
// onBarClick / onRequestMoreData / onChartReady).
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

'use client';

import { lazy, Suspense } from 'react';

import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';

const ChartInner = lazy(() => import('./ChartInner'));

interface Props {
  candles: Candle[];
  instrument: string;            // display label, e.g. "BTC", "EURUSD", "AAPL"
  assetClass: ChartAssetClass;   // drives price-axis precision (FX pipettes etc.)
  timeframe: Timeframe;
  height?: number;
}

export function CandlestickChart({ candles, instrument, assetClass, timeframe, height }: Props) {
  return (
    <Suspense
      fallback={
        <div
          style={{ height: height ?? '100%', background: 'var(--color-paper)' }}
          aria-label="Loading chart"
        />
      }
    >
      <ChartInner
        candles={candles}
        instrument={instrument}
        assetClass={assetClass}
        timeframe={timeframe}
        height={height}
      />
    </Suspense>
  );
}
