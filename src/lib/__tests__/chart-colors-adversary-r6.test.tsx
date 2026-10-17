// @vitest-environment jsdom
// Adversary r6 on feat/chart-colors@1fb7835 (owner spec 2026-10-17: candle colours "like trading view", the change live
// on the chart; the menu's signed-out and loading states).
//
// 1. A colour change is meant to repaint the candles and volume bars, nothing more. ChartInner instead puts
//    `candleColors` in the deps of the data effect, which re-sends every series' data AND calls
//    timeScale().fitContent(), so each picker step (and the save 500 ms later, whose cached object is a new identity)
//    throws away the user's zoom and scroll. TradingView keeps the view when a colour changes.
// 2. While the session check (/api/user/me) is still loading, or after it fails, useUser() gives user = null, and the
//    menu tells a SIGNED-IN user "Sign in to change and keep your colours." instead of the loading / failed text.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS } from '../chart-colors';

// ---- lightweight-charts: a recording fake ------------------------------------------------------------------------
const lw = vi.hoisted(() => {
  const log = { fitContent: 0, setVisibleLogicalRange: [] as unknown[], volumeData: [] as unknown[][], candleOptions: [] as Record<string, unknown>[] };
  const series = (kind: string) => ({
    setData: (d: unknown[]) => {
      if (kind === 'histogram') log.volumeData.push(d);
    },
    applyOptions: (o: Record<string, unknown>) => {
      if (kind === 'candle') log.candleOptions.push(o);
    },
  });
  const createChart = vi.fn(() => ({
    applyOptions: () => {},
    addCandlestickSeries: (o: Record<string, unknown>) => (log.candleOptions.push(o), series('candle')),
    addHistogramSeries: () => series('histogram'),
    addLineSeries: () => series('line'),
    removeSeries: () => {},
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({
      fitContent: () => {
        log.fitContent += 1;
      },
      getVisibleLogicalRange: () => ({ from: 10, to: 20 }),
      setVisibleLogicalRange: (r: unknown) => log.setVisibleLogicalRange.push(r),
    }),
    remove: () => {},
  }));
  return { log, createChart };
});
vi.mock('lightweight-charts', () => ({
  createChart: lw.createChart,
  ColorType: { Solid: 'solid' },
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
}));

const user = vi.hoisted(() => ({ value: { user: null as unknown, isLoading: true, isError: false } }));
// MarketChart's chart is reduced to a marker for the menu test (ChartInner itself is imported directly above it).
vi.mock('@/components/chart/CandlestickChart', () => ({ CandlestickChart: () => <div data-testid="candlestick-chart" /> }));
vi.mock('@/lib/use-user', () => ({ useUser: () => user.value }));

import ChartInner, { type ChartInnerHandle } from '../../components/chart/ChartInner';
import { MarketChart } from '../../components/MarketChart';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const CANDLES = Array.from({ length: 40 }, (_, i) => ({ timestamp: 1_700_000_000_000 + i * 3_600_000, open: 1, high: 2, low: 0.5, close: i % 2 ? 1.5 : 0.8, volume: 10 }));

describe('a candle colour change repaints the chart without resetting the view', () => {
  it('candles and volume take the new colour; the zoom the user set is kept (no fitContent)', async () => {
    const ref = React.createRef<ChartInnerHandle>();
    const el = (colors: typeof DEFAULT_CHART_COLORS) => (
      <ChartInner ref={ref} candles={CANDLES} instrument="BTC" assetClass="CRYPTO" timeframe="1h" height={300} showVolume showMA20={false} showEMA50={false} candleColors={colors} />
    );
    const v = render(el(DEFAULT_CHART_COLORS));
    // The user zooms in: the view is now theirs.
    act(() => ref.current!.zoomIn());
    expect(lw.log.setVisibleLogicalRange).toHaveLength(1);
    const fitsBefore = lw.log.fitContent;
    const volumesBefore = lw.log.volumeData.length;

    // One picker step: rising body to blue.
    v.rerender(el({ ...DEFAULT_CHART_COLORS, upBody: '#0000ff' }));

    // Repainted: the candle series got the new body colour, and the volume bars were re-coloured.
    expect(lw.log.candleOptions.at(-1)).toMatchObject({ upColor: '#0000ff' });
    expect(lw.log.volumeData.length).toBeGreaterThan(volumesBefore);
    expect(JSON.stringify(lw.log.volumeData.at(-1))).toContain('rgba(0, 0, 255, 0.5)');
    // ...but the user's zoom is not thrown away.
    expect(lw.log.fitContent - fitsBefore).toBe(0);
  });
});

describe("the menu's status text before the session is known", () => {
  it('while /api/user/me is still loading, the menu does not tell the user to sign in', async () => {
    // Charts answer; the session check never does (still loading).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('/api/charts')
          ? new Response(JSON.stringify({ candles: CANDLES }), { status: 200 })
          : new Promise<Response>(() => {}),
      ),
    );
    user.value = { user: null, isLoading: true, isError: false };
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByLabelText('Indicators menu'));
    expect(screen.getAllByLabelText(/candle (body|border|wick) colour/)).toHaveLength(6);
    // Whether the user is signed in is not known yet, so the signed-out instruction is wrong for a signed-in user.
    expect(screen.queryByText('Sign in to change and keep your colours.')).toBeNull();
  });
});
