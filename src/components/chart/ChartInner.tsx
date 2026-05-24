// ----------------------------------------------------------------------------
// src/components/chart/ChartInner.tsx
//
// lightweight-charts host. Lazy-loaded via `CandlestickChart` so
// the ~50KB charting bundle stays out of the initial route chunk.
//
// Polish r6: added forwardRef + useImperativeHandle to expose
// zoom controls (zoomIn / zoomOut / fitContent) to the parent
// header strip. Also added togglable Volume histogram + MA20 /
// EMA50 line overlays computed client-side from the candle data.
// Drawing tools (trendlines / fib) are NOT included — lightweight-
// charts has no drawing API; that needs a library swap to deliver.
// ----------------------------------------------------------------------------

'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  createChart,
  CrosshairMode,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
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
  showVolume?: boolean;
  showMA20?: boolean;
  showEMA50?: boolean;
}

export interface ChartInnerHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

type BrandColors = {
  ink: string;
  paper: string;
  makoRed: string;
  signal: string;
  divider: string;
  grid: string;
  muted: string;
};

const FALLBACK: BrandColors = {
  ink:     '#000000',
  paper:   '#EBE5D9',
  makoRed: '#D94A3D',
  signal:  '#FACC15',
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
    signal:  pick('--color-signal',            FALLBACK.signal),
    divider: pick('--color-canvas-divider',    FALLBACK.divider),
    grid:    pick('--mako-grid',               FALLBACK.grid),
    muted:   pick('--color-muted',             FALLBACK.muted),
  };
}

function derivePrecision(
  candles: Candle[],
  assetClass: ChartAssetClass,
): { precision: number; minMove: number } {
  if (assetClass === 'FOREX')       return { precision: 5, minMove: 0.00001 };
  if (assetClass === 'COMMODITIES') return { precision: 2, minMove: 0.01 };
  if (assetClass === 'STOCKS')      return { precision: 2, minMove: 0.01 };
  if (candles.length === 0) return { precision: 2, minMove: 0.01 };
  const lastClose = candles[candles.length - 1].close;
  if (lastClose >= 1000) return { precision: 1, minMove: 0.1 };
  if (lastClose >= 10)   return { precision: 2, minMove: 0.01 };
  if (lastClose >= 1)    return { precision: 4, minMove: 0.0001 };
  return { precision: 5, minMove: 0.00001 };
}

function toChartData(candles: Candle[]): CandlestickData<Time>[] {
  return candles.map((c) => ({
    time: (c.timestamp / 1000) as Time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

function toVolumeData(candles: Candle[], upColor: string, downColor: string): HistogramData<Time>[] {
  return candles.map((c) => ({
    time: (c.timestamp / 1000) as Time,
    value: c.volume,
    color: c.close >= c.open ? upColor : downColor,
  }));
}

// Simple moving average of `period` closes. Returns same-length array
// where indices [0, period-2] are skipped (no enough history yet).
function computeMA(candles: Candle[], period: number): LineData<Time>[] {
  if (candles.length < period) return [];
  const out: LineData<Time>[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) {
      out.push({
        time: (candles[i].timestamp / 1000) as Time,
        value: sum / period,
      });
    }
  }
  return out;
}

// Exponential moving average. k = 2/(period+1). First EMA value is
// the SMA of the first `period` closes (standard seeding).
function computeEMA(candles: Candle[], period: number): LineData<Time>[] {
  if (candles.length < period) return [];
  const k = 2 / (period + 1);
  const out: LineData<Time>[] = [];
  let ema = 0;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) {
      sum += candles[i].close;
      if (i === period - 1) {
        ema = sum / period;
        out.push({
          time: (candles[i].timestamp / 1000) as Time,
          value: ema,
        });
      }
      continue;
    }
    ema = candles[i].close * k + ema * (1 - k);
    out.push({
      time: (candles[i].timestamp / 1000) as Time,
      value: ema,
    });
  }
  return out;
}

const ChartInner = forwardRef<ChartInnerHandle, Props>(function ChartInner(
  { candles, instrument: _instrument, assetClass, timeframe: _timeframe, height, showVolume, showMA20, showEMA50 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);

  // Imperative API exposed to parent (zoom buttons in header).
  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      const chart = chartRef.current;
      if (!chart) return;
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const shrink = span * 0.2;
      ts.setVisibleLogicalRange({ from: range.from + shrink, to: range.to - shrink });
    },
    zoomOut: () => {
      const chart = chartRef.current;
      if (!chart) return;
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const grow = span * 0.25;
      ts.setVisibleLogicalRange({ from: range.from - grow, to: range.to + grow });
    },
    fit: () => {
      chartRef.current?.timeScale().fitContent();
    },
  }), []);

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
    series.applyOptions({
      upColor:         c.ink,
      downColor:       c.makoRed,
      borderUpColor:   c.ink,
      borderDownColor: c.makoRed,
      wickUpColor:     c.ink,
      wickDownColor:   c.makoRed,
    });
    // Re-apply MA/EMA colors so they stay legible on theme flip.
    ma20Ref.current?.applyOptions({ color: c.signal });
    ema50Ref.current?.applyOptions({ color: c.makoRed });
    if (volumeRef.current) {
      // Histogram per-bar colors are baked into the data points; the
      // setData below in the candles effect refreshes them. Nothing
      // to apply here directly.
    }
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
      volumeRef.current = null;
      ma20Ref.current = null;
      ema50Ref.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const refresh = () => applyColors(chart, series, readBrandColors());
    refresh();

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

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const { precision, minMove } = derivePrecision(candles, assetClass);
    series.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
  }, [candles, assetClass]);

  // Volume histogram series — created on demand. Lives on its own
  // price scale ('') stacked below the main candles via scaleMargins.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (showVolume) {
      if (!volumeRef.current) {
        const colors = readBrandColors();
        const vol = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          color: colors.muted,
        });
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
        });
        volumeRef.current = vol;
      }
    } else if (volumeRef.current) {
      chart.removeSeries(volumeRef.current);
      volumeRef.current = null;
    }
  }, [showVolume]);

  // MA(20) line overlay — created on demand.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (showMA20) {
      if (!ma20Ref.current) {
        const colors = readBrandColors();
        ma20Ref.current = chart.addLineSeries({
          color: colors.signal,
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
    } else if (ma20Ref.current) {
      chart.removeSeries(ma20Ref.current);
      ma20Ref.current = null;
    }
  }, [showMA20]);

  // EMA(50) line overlay — created on demand.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (showEMA50) {
      if (!ema50Ref.current) {
        const colors = readBrandColors();
        ema50Ref.current = chart.addLineSeries({
          color: colors.makoRed,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
    } else if (ema50Ref.current) {
      chart.removeSeries(ema50Ref.current);
      ema50Ref.current = null;
    }
  }, [showEMA50]);

  // Push candle data + derived overlays. Dedupe + sort.
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

    const colors = readBrandColors();
    series.setData(toChartData(unique));
    if (volumeRef.current) {
      volumeRef.current.setData(toVolumeData(unique, colors.ink, colors.makoRed));
    }
    if (ma20Ref.current) {
      ma20Ref.current.setData(computeMA(unique, 20));
    }
    if (ema50Ref.current) {
      ema50Ref.current.setData(computeEMA(unique, 50));
    }
    chart?.timeScale().fitContent();
  }, [candles, showVolume, showMA20, showEMA50]);

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
});

export default ChartInner;
