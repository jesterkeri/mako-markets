// ----------------------------------------------------------------------------
// src/components/chart/ChartInner.tsx
//
// lightweight-charts host. Lazy-loaded via `CandlestickChart` so
// the ~50KB charting bundle stays out of the initial route chunk.
//
// Ported from krait `apps/web/src/components/chart/ChartInner.tsx`,
// then trimmed and restyled for mako:
//   - Removed: livePrice / replay / onBarClick / onRequestMoreData
//     (out of scope for #166 v1)
//   - Removed: krait-specific instrument-format table (mako asset
//     classes follow a different precision rule, derived from the
//     candle data itself)
//   - Replaced: hard-coded hex colors → brand tokens read from CSS
//     vars at mount, refreshed on `data-theme` change so the chart
//     re-colors live without unmount
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from 'lightweight-charts';

import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';

interface Props {
  candles: Candle[];
  instrument: string;
  assetClass: ChartAssetClass;
  timeframe: Timeframe;
  height?: number;
}

// Mako brand palette fallbacks. Used when `getComputedStyle` returns
// '' (CSS not yet loaded on initial paint). Values mirror the light-
// theme tokens in `src/app/globals.css`; dark-theme rendering kicks
// in once the MutationObserver fires.
type BrandColors = {
  ink: string;
  paper: string;
  makoRed: string;
  divider: string;
  grid: string;
  muted: string;
};

const FALLBACK: BrandColors = {
  ink:     '#000000',
  paper:   '#EBE5D9',
  makoRed: '#D94A3D',
  divider: 'rgba(0, 0, 0, 0.10)',
  grid:    'rgba(0, 0, 0, 0.05)',
  muted:   '#79797A',
};

function readBrandColors(): BrandColors {
  if (typeof window === 'undefined') return FALLBACK;
  const styles = getComputedStyle(document.documentElement);
  const pick = (varName: string, fallback: string) => {
    const v = styles.getPropertyValue(varName).trim();
    return v || fallback;
  };
  return {
    ink:     pick('--color-ink',               FALLBACK.ink),
    paper:   pick('--color-paper',             FALLBACK.paper),
    makoRed: pick('--color-mako-red',          FALLBACK.makoRed),
    divider: pick('--color-canvas-divider',    FALLBACK.divider),
    grid:    pick('--mako-grid',               FALLBACK.grid),
    muted:   pick('--color-muted',             FALLBACK.muted),
  };
}

/**
 * Price-axis precision rules per asset class.
 *
 * - FOREX: always 5 decimals (pipette resolution — EUR/USD trades
 *   in 0.00001 increments even though the spot value is ~1.10).
 *   The close-value heuristic alone would land on 4dp for EUR/USD
 *   which loses information codex r1 MINOR flagged.
 * - COMMODITIES: 2dp (XAU at $3400, XAG at $30, XPT at $1000).
 * - STOCKS: 2dp (US equities tick in pennies).
 * - CRYPTO: close-value heuristic — BTC at 1dp, ETH/SOL at 2dp,
 *   DOGE/etc at 4dp. Wide range of magnitudes inside the class.
 */
function derivePrecision(
  candles: Candle[],
  assetClass: ChartAssetClass,
): { precision: number; minMove: number } {
  if (assetClass === 'FOREX')       return { precision: 5, minMove: 0.00001 };
  if (assetClass === 'COMMODITIES') return { precision: 2, minMove: 0.01 };
  if (assetClass === 'STOCKS')      return { precision: 2, minMove: 0.01 };
  // CRYPTO: magnitude-based fallback
  if (candles.length === 0) return { precision: 2, minMove: 0.01 };
  const lastClose = candles[candles.length - 1].close;
  if (lastClose >= 1000) return { precision: 1, minMove: 0.1 };    // BTC
  if (lastClose >= 10)   return { precision: 2, minMove: 0.01 };   // ETH, SOL, AVAX
  if (lastClose >= 1)    return { precision: 4, minMove: 0.0001 }; // LINK
  return { precision: 5, minMove: 0.00001 };                       // DOGE et al.
}

function toChartData(candles: Candle[]): CandlestickData<Time>[] {
  return candles.map((c) => ({
    time: (c.timestamp / 1000) as Time,  // krait stores ms; lightweight-charts wants seconds
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

export default function ChartInner({ candles, instrument: _instrument, assetClass, timeframe: _timeframe, height }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  // Build options derived from current brand-color readout.
  // Pure helper — exported here as a local for the theme effect's reuse.
  const applyColors = (chart: IChartApi, series: ISeriesApi<'Candlestick'>, c: BrandColors) => {
    chart.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: c.paper },
        textColor: c.ink,
      },
      grid: {
        vertLines: { color: c.grid },
        horzLines: { color: c.grid },
      },
      timeScale:       { borderColor: c.divider },
      rightPriceScale: { borderColor: c.divider },
    });
    // Neobrutalist palette: ink-up (black) / mako-red-down (no green).
    series.applyOptions({
      upColor:         c.ink,
      downColor:       c.makoRed,
      borderUpColor:   c.ink,
      borderDownColor: c.makoRed,
      wickUpColor:     c.ink,
      wickDownColor:   c.makoRed,
    });
  };

  // Initialise chart on mount. Re-init on height change (rare).
  useEffect(() => {
    if (!containerRef.current) return;

    const colors = readBrandColors();
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: colors.paper },
        textColor: colors.ink,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: {
        timeVisible: true,
        borderColor: colors.divider,
        rightOffset: 5,
      },
      rightPriceScale: {
        borderColor: colors.divider,
        scaleMargins: { top: 0.1, bottom: 0.1 },
        entireTextOnly: true,
      },
      width: containerRef.current.clientWidth,
      height: height ?? containerRef.current.clientHeight,
    });

    const { precision, minMove } = derivePrecision(candles, assetClass);
    const series = chart.addCandlestickSeries({
      upColor:         colors.ink,
      downColor:       colors.makoRed,
      borderUpColor:   colors.ink,
      borderDownColor: colors.makoRed,
      wickUpColor:     colors.ink,
      wickDownColor:   colors.makoRed,
      priceFormat: { type: 'price', precision, minMove },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    // Resize on container width changes.
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Intentional: re-init only on height change. Color/candle updates
    // flow through separate effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // Theme-aware recolor. Listens for `data-theme` attribute changes
  // on <html> and re-reads CSS vars without remounting the chart.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const refresh = () => applyColors(chart, series, readBrandColors());
    refresh(); // first paint may have run with FALLBACK if CSS was late

    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh price-axis precision when the asset class changes OR
  // when crypto candles cross a magnitude bucket. The init effect
  // only runs on mount (deps = [height]), so when App Router keeps
  // this component mounted across `/market/[id]` navigations the
  // series would otherwise hold the previous market's priceFormat.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const { precision, minMove } = derivePrecision(candles, assetClass);
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
  }, [candles, assetClass]);

  // Push candle data. Dedupe by timestamp + sort ascending (the
  // backend already does this but defense-in-depth is cheap and
  // catches future client-side concat bugs).
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || candles.length === 0) return;

    const seen = new Set<number>();
    const unique = candles.filter((c) => {
      if (seen.has(c.timestamp)) return false;
      seen.add(c.timestamp);
      return true;
    });
    unique.sort((a, b) => a.timestamp - b.timestamp);

    series.setData(toChartData(unique));
    chart?.timeScale().fitContent();
  }, [candles]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: height ?? '100%',
        position: 'relative',
      }}
    />
  );
}
