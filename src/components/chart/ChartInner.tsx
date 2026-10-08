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
  scrollWithPage?: boolean;
  showMA20?: boolean;
  showEMA50?: boolean;
  /** Fires once the chart + candle series are constructed, so a
   *  parent overlay (e.g. DrawingCanvas) can subscribe to the same
   *  instances. Called with (null, null) on teardown. */
  onChartReady?: (chart: IChartApi | null, series: ISeriesApi<'Candlestick'> | null) => void;
}

export interface ChartInnerHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

/// The chart's palette in the redesign (2a/5a): yellow up and red down candles on the page canvas, text and lines from
/// the canvas foreground, MA and EMA in teal and cyan so they never read as candles. Read from the chart's own
/// container, so the theme the surrounding page sets (light or dark) is the one drawn.
type BrandColors = {
  ink: string;
  paper: string;
  up: string;
  makoRed: string;
  ma: string;
  ema: string;
  /// Candle outline and wicks: black in light mode so yellow stands out on cream (design --edge-c, --wick-up/-dn);
  /// in dark mode the outline is the candle's own colour and the wicks are yellow and red.
  upBorder: string;
  downBorder: string;
  wickUp: string;
  wickDown: string;
  divider: string;
  grid: string;
  muted: string;
};

const FALLBACK: BrandColors = {
  ink:     '#EBE5D9',
  paper:   '#000000',
  up:      '#FACC15',
  makoRed: '#D94A3D',
  ma:      '#14B8A6',
  ema:     '#06B6D4',
  upBorder: '#FACC15',
  downBorder: '#D94A3D',
  wickUp:  '#FACC15',
  wickDown: '#D94A3D',
  divider: 'rgba(235, 229, 217, 0.12)',
  grid:    'rgba(235, 229, 217, 0.06)',
  muted:   'rgba(235, 229, 217, 0.45)',
};

/// `#rgb` or `#rrggbb` at `a` opacity, for the chart library (it does not parse color-mix()); null for anything else.
export function withAlpha(hex: string, a: number): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function readBrandColors(el?: Element | null): BrandColors {
  if (typeof window === 'undefined') return FALLBACK;
  const styles = getComputedStyle(el ?? document.documentElement);
  const pick = (varName: string, fallback: string) => {
    const v = styles.getPropertyValue(varName).trim();
    return v || fallback;
  };
  const ink = pick('--mako-canvas-fg', FALLBACK.ink);
  const up = pick('--mako-signal', FALLBACK.up);
  const makoRed = pick('--mako-red', FALLBACK.makoRed);
  // --edge-c is 'transparent' in dark mode: the candle is then outlined in its own colour.
  const edge = pick('--edge-c', 'transparent');
  const outlined = edge !== 'transparent' && edge !== '';
  return {
    ink,
    paper:   pick('--mako-canvas',  FALLBACK.paper),
    up,
    makoRed,
    upBorder: outlined ? edge : up,
    downBorder: outlined ? edge : makoRed,
    wickUp:  pick('--wick-up', up),
    wickDown: pick('--wick-dn', makoRed),
    ma:      pick('--mako-teal',    FALLBACK.ma),
    ema:     pick('--mako-cyan',    FALLBACK.ema),
    divider: withAlpha(ink, 0.12) ?? FALLBACK.divider,
    grid:    withAlpha(ink, 0.06) ?? FALLBACK.grid,
    muted:   withAlpha(ink, 0.45) ?? FALLBACK.muted,
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
  { candles, instrument: _instrument, assetClass, timeframe: _timeframe, height, showVolume, showMA20, showEMA50, scrollWithPage, onChartReady },
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
      upColor:         c.up,
      downColor:       c.makoRed,
      borderUpColor:   c.upBorder,
      borderDownColor: c.downBorder,
      wickUpColor:     c.wickUp,
      wickDownColor:   c.wickDown,
    });
    // Re-apply MA/EMA colors so they stay legible on theme flip.
    ma20Ref.current?.applyOptions({ color: c.ma });
    ema50Ref.current?.applyOptions({ color: c.ema });
    if (volumeRef.current) {
      // Histogram per-bar colors are baked into the data points; the
      // setData below in the candles effect refreshes them. Nothing
      // to apply here directly.
    }
  };

  // Initialise chart on mount. Re-init on height change (rare).
  useEffect(() => {
    if (!containerRef.current) return;

    const colors = readBrandColors(containerRef.current);
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
      // In a scrolling page the library's defaults would claim every vertical finger drag (vertTouchDrag) and the
      // wheel, so a thumb on the chart could not scroll the page. Pinch and horizontal drag still move the chart.
      ...(scrollWithPage
        ? {
            handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
          }
        : {}),
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
      upColor:         colors.up,
      downColor:       colors.makoRed,
      borderUpColor:   colors.upBorder,
      borderDownColor: colors.downBorder,
      wickUpColor:     colors.wickUp,
      wickDownColor:   colors.wickDown,
      priceFormat: { type: 'price', precision, minMove },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    onChartReady?.(chart, series);

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      onChartReady?.(null, null);
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

    const refresh = () => applyColors(chart, series, readBrandColors(containerRef.current));
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
        const colors = readBrandColors(containerRef.current);
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
        const colors = readBrandColors(containerRef.current);
        ma20Ref.current = chart.addLineSeries({
          color: colors.ma,
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
        const colors = readBrandColors(containerRef.current);
        ema50Ref.current = chart.addLineSeries({
          color: colors.ema,
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

    const colors = readBrandColors(containerRef.current);
    series.setData(toChartData(unique));
    if (volumeRef.current) {
      volumeRef.current.setData(toVolumeData(unique, withAlpha(colors.up, 0.5) ?? colors.up, withAlpha(colors.makoRed, 0.5) ?? colors.makoRed));
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
