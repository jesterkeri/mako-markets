// ----------------------------------------------------------------------------
// src/components/chart/CandlestickChart.tsx
//
// Thin wrapper around the heavy `ChartInner` (which pulls in
// `lightweight-charts` ~50KB gzipped). React.lazy + Suspense
// keeps that bundle out of the initial chunk.
//
// Polish r6: now forwards a ref to ChartInner so the parent
// MarketChart can call zoom/fit imperatively from header buttons.
// ----------------------------------------------------------------------------

'use client';

import { forwardRef, lazy, Suspense } from 'react';

import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';
import type { ChartInnerHandle } from './ChartInner';

const ChartInner = lazy(() => import('./ChartInner'));

interface Props {
  candles: Candle[];
  instrument: string;
  assetClass: ChartAssetClass;
  timeframe: Timeframe;
  height?: number;
  showVolume?: boolean;
  showMA20?: boolean;
  showEMA50?: boolean;
  /// On a pool or round page the chart sits in a scrolling page: vertical swipes and the mouse wheel scroll the page,
  /// pinch and horizontal drag still move the chart (adversary on cb71ae1). The chart page leaves it off.
  scrollWithPage?: boolean;
  onChartReady?: (chart: IChartApi | null, series: ISeriesApi<'Candlestick'> | null) => void;
}

export const CandlestickChart = forwardRef<ChartInnerHandle, Props>(
  function CandlestickChart(props, ref) {
    return (
      <Suspense
        fallback={
          <div
            style={{ height: props.height ?? '100%', background: 'var(--color-paper)' }}
            aria-label="Loading chart"
          />
        }
      >
        <ChartInner ref={ref} {...props} />
      </Suspense>
    );
  },
);
