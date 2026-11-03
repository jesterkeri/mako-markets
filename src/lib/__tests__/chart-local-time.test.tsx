// Chart times follow the viewer's own time zone (owner, 2026-11-03). lightweight-charts labels every time as UTC, so
// a viewer in UTC+1 at 09:58 saw the newest candle labelled 08:45. Every time given to the chart is now shifted by
// the viewer's UTC offset (one constant per page load, from src/lib/chart-time.ts), so the chart's UTC label reads as
// local wall-clock time. The offset is stubbed through Date.prototype.getTimezoneOffset, never a real TZ.
import { cleanup, fireEvent, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- lightweight-charts: record what each series is given -------------------------------------------------------
const lw = vi.hoisted(() => {
  const data: Record<string, { time: unknown }[][]> = { candle: [], histogram: [], line: [] };
  const series = (kind: string) => ({ setData: (d: { time: unknown }[]) => data[kind].push(d), applyOptions: () => {} });
  const createChart = () => ({
    applyOptions: () => {},
    addCandlestickSeries: () => series('candle'),
    addHistogramSeries: () => series('histogram'),
    addLineSeries: () => series('line'),
    removeSeries: () => {},
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({ fitContent: () => {} }),
    remove: () => {},
  });
  return { data, createChart };
});
vi.mock('lightweight-charts', () => ({
  createChart: lw.createChart,
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {} })) as never;
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
});
beforeEach(() => {
  // chart-time.ts keeps the offset for the page load; each test is a fresh page load.
  vi.resetModules();
  for (const k of Object.keys(lw.data)) lw.data[k].length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The viewer is at UTC + `offsetSec` (getTimezoneOffset is minutes, sign flipped). */
function viewerAt(offsetSec: number) {
  vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-offsetSec / 60);
}

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 3, 8, 45); // 2026-11-03 08:45 UTC: the owner's "last candle labelled 08:45"
// 60 hourly candles, given out of order with two duplicates, as a refetch can deliver them.
const ORDERED = Array.from({ length: 60 }, (_, i) => ({ timestamp: T0 - (59 - i) * H, open: 1, high: 2, low: 0.5, close: 1 + (i % 7) / 10, volume: 10 + i }));
const GIVEN = [...ORDERED.slice(30), ORDERED[40], ...ORDERED.slice(0, 30), ORDERED[5]];

async function renderChart(props: Partial<{ showVolume: boolean; showMA20: boolean; showEMA50: boolean }> = { showVolume: true, showMA20: true, showEMA50: true }) {
  const { default: ChartInner } = await import('@/components/chart/ChartInner');
  render(<ChartInner candles={GIVEN} instrument="BTC" assetClass="CRYPTO" timeframe="1h" height={300} {...props} />);
  const last = (k: string) => (lw.data[k][lw.data[k].length - 1] ?? []).map((p) => p.time as number);
  return { candle: last('candle'), volume: last('histogram'), lines: lw.data.line.map((d) => d.map((p) => p.time as number)) };
}

/** The label lightweight-charts draws for a chart time: its UTC hour and minute. */
const label = (chartTimeSec: number) => new Date(chartTimeSec * 1000).toISOString().slice(11, 16);

describe('chart-time helper', () => {
  it('UTC+1: a real instant becomes a chart time 3600 s later, labelled with the local wall clock', async () => {
    viewerAt(3600);
    const { chartTimeOffsetSec, toChartTime, fromChartTime } = await import('@/lib/chart-time');
    expect(chartTimeOffsetSec()).toBe(3600);
    expect(toChartTime(T0)).toBe(T0 / 1000 + 3600);
    expect(label(toChartTime(T0) as number)).toBe('09:45');
    expect(fromChartTime(toChartTime(T0))).toBe(T0);
  });

  it('UTC-5: the shift is negative', async () => {
    viewerAt(-18000);
    const { chartTimeOffsetSec, toChartTime, fromChartTime } = await import('@/lib/chart-time');
    expect(chartTimeOffsetSec()).toBe(-18000);
    expect(toChartTime(T0)).toBe(T0 / 1000 - 18000);
    expect(label(toChartTime(T0) as number)).toBe('03:45');
    expect(fromChartTime(toChartTime(T0))).toBe(T0);
  });

  it('UTC viewer: no shift (and 0, not -0)', async () => {
    viewerAt(0);
    const { chartTimeOffsetSec, toChartTime } = await import('@/lib/chart-time');
    expect(Object.is(chartTimeOffsetSec(), 0)).toBe(true);
    expect(toChartTime(T0)).toBe(T0 / 1000);
  });

  it('one offset per page load: a later offset change (a DST switch while the page is open) does not move it', async () => {
    viewerAt(3600);
    const { chartTimeOffsetSec, toChartTime } = await import('@/lib/chart-time');
    expect(chartTimeOffsetSec()).toBe(3600);
    viewerAt(7200);
    expect(chartTimeOffsetSec()).toBe(3600);
    expect(toChartTime(T0)).toBe(T0 / 1000 + 3600);
  });
});

describe('ChartInner gives every series the shifted times', () => {
  for (const offset of [3600, -18000]) {
    it(`offset ${offset} s: candles shifted, sorted and deduped; volume, MA20 and EMA50 shifted the same`, async () => {
      viewerAt(offset);
      const { candle, volume, lines } = await renderChart();
      const want = ORDERED.map((c) => c.timestamp / 1000 + offset);
      expect(candle).toEqual(want);
      expect(volume).toEqual(want);
      // One line series per overlay: MA20 starts at the 20th candle, EMA50 at the 50th.
      expect(lines).toHaveLength(2);
      const [ma, ema] = [...lines].sort((a, b) => b.length - a.length);
      expect(ma).toEqual(want.slice(19));
      expect(ema).toEqual(want.slice(49));
      // Strictly ascending, as lightweight-charts requires.
      for (let i = 1; i < candle.length; i++) expect(candle[i]).toBeGreaterThan(candle[i - 1]);
    });
  }

  it('the newest candle (08:45 UTC) is labelled 09:45 for a UTC+1 viewer, not 08:45', async () => {
    viewerAt(3600);
    const { candle } = await renderChart({});
    expect(label(candle[candle.length - 1])).toBe('09:45');
  });
});

describe('drawings stay in chart time (no second shift)', () => {
  it('a drawing placed on a candle stores that candle\'s chart time and is drawn back at the same x', async () => {
    viewerAt(3600);
    const { candle } = await renderChart({});
    // The time scale maps the series' own (shifted) times to x, 10 px per candle, as lightweight-charts does.
    const x = (t: number) => candle.indexOf(t) * 10;
    const timeToCoordinate = vi.fn((t: number) => (candle.includes(t) ? x(t) : null));
    const chart = {
      timeScale: () => ({ coordinateToTime: (px: number) => candle[Math.round(px / 10)] ?? null, timeToCoordinate, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {} }),
      subscribeCrosshairMove: () => {},
      unsubscribeCrosshairMove: () => {},
    } as never;
    const series = { coordinateToPrice: (y: number) => y, priceToCoordinate: (p: number) => p } as never;
    const { DrawingCanvas } = await import('@/components/chart/DrawingCanvas');
    const onAddDrawing = vi.fn<(d: { points: { time: number; price: number }[] }) => string>(() => 'd1');
    const view = (drawings: never[]) => (
      <div style={{ position: 'relative', width: 600, height: 300 }}>
        <DrawingCanvas chart={chart} series={series} drawings={drawings} activeTool="horizontal-ray" activeColor="#fff" selectedId={null} onAddDrawing={onAddDrawing} onRemoveDrawing={() => {}} onSelectDrawing={() => {}} />
      </div>
    );
    const { container, rerender } = render(view([]));
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    (canvas.parentElement as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(canvas, { clientX: 590, clientY: 100, pointerId: 1, pointerType: 'mouse', buttons: 1 });
    expect(onAddDrawing).toHaveBeenCalledTimes(1);
    const point = onAddDrawing.mock.calls[0][0].points[0]!;
    expect(point.time).toBe(T0 / 1000 + 3600); // the newest candle's chart time, unconverted

    timeToCoordinate.mockClear();
    rerender(view([{ id: 'd1', type: 'horizontal-ray', points: [point], color: '#fff', lineWidth: 1, lineStyle: 'solid', locked: false }] as never));
    expect(timeToCoordinate).toHaveBeenCalledWith(point.time);
    expect(timeToCoordinate).not.toHaveBeenCalledWith(point.time + 3600);
    expect(timeToCoordinate).not.toHaveBeenCalledWith(point.time - 3600);
  });
});
