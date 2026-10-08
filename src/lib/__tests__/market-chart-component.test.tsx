// ----------------------------------------------------------------------------
// market-chart-component.test.tsx
//
// RTL integration tests for the `<MarketChart>` glue component.
//
// Unit coverage of the decision boundary (sports/MAKO/MON return
// null) lives in `market-chart.test.ts` against the pure decoder.
// This file covers the integrated component behaviour:
//   - loading skeleton → chart render on fetch success
//   - error UI on fetch failure with working retry
//   - commodity daily-only banner
//   - tf-reset on assetClass change (codex r1 MAJOR fix)
//
// CandlestickChart is mocked so we don't pull lightweight-charts
// (which would need a real canvas + lightweight-charts internals
// happy-dom doesn't fully support). The unit responsibility under
// test is MarketChart's data-fetching + UI state machine.
//
// Plan: %TEMP%/mako-166-charts-plan.md  Memory: [[mako-charts]]
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock CandlestickChart BEFORE importing MarketChart so the lazy
// import doesn't try to pull lightweight-charts.
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: ({ candles, instrument, timeframe }: { candles: unknown[]; instrument: string; timeframe: string }) => (
    <div
      data-testid="candlestick-chart"
      data-instrument={instrument}
      data-timeframe={timeframe}
      data-candle-count={candles.length}
    />
  ),
}));

import { change24h, MarketChart } from '../../components/MarketChart';
import type { ChartAssetClass } from '../chart-symbols';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const SAMPLE_CANDLES = [
  { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 },
  { timestamp: 1_700_003_600_000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 0 },
];

function mockChartsFetch(body: unknown, status = 200) {
  // mockImplementation so each fetch call gets a fresh Response
  // (Response bodies are one-shot — calling .json() twice on the
  // same instance throws).
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(body), { status }) as Response,
  );
}

describe('<MarketChart>', () => {
  it('shows loading skeleton, then renders chart on fetch success', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES });
    const { container, findByTestId } = renderWithQuery(
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />,
    );

    // Initial render: loading skeleton (animate-pulse)
    expect(container.querySelector('.animate-pulse')).toBeTruthy();

    // After fetch resolves: chart appears
    const chart = await findByTestId('candlestick-chart');
    expect(chart.getAttribute('data-instrument')).toBe('BTC');
    expect(chart.getAttribute('data-timeframe')).toBe('1h');
    expect(chart.getAttribute('data-candle-count')).toBe('2');
  });

  it('builds the right /api/charts URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response,
    );
    renderWithQuery(<MarketChart oracleSymbol="EURUSD" assetClass="FOREX" />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toBe('/api/charts?s=EURUSD&tf=1h');
  });

  it('shows error UI with retry when fetch fails', async () => {
    // MarketChart's useQuery has `retry: 1` so the QueryClient hits
    // the failing endpoint twice before settling into the error
    // state. Bump the RTL timeout above the default 1000ms.
    mockChartsFetch({ error: 'rate_limited' }, 503);
    const { findByRole, findByText } = renderWithQuery(
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />,
    );

    await findByText('PRICE CHART UNAVAILABLE RIGHT NOW', undefined, { timeout: 3000 });
    const retry = await findByRole('button', { name: /RETRY/ }, { timeout: 3000 });
    expect(retry).toBeTruthy();
  });

  it('retry button refires the fetch', async () => {
    // First fetch fails twice (initial + retry: 1) → error UI →
    // user clicks RETRY → second wave succeeds. Three total fetch
    // calls expected: 2 from the initial useQuery, 1 from refetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'fail' }), { status: 503 }) as Response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'fail' }), { status: 503 }) as Response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response);

    const { findByRole, findByTestId } = renderWithQuery(
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />,
    );
    const retry = await findByRole('button', { name: /RETRY/ }, { timeout: 3000 });
    fireEvent.click(retry);
    await findByTestId('candlestick-chart', undefined, { timeout: 3000 });
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('defaults to 1h for all asset classes (Pyth supports commodity intraday too)', async () => {
    const fresh = () =>
      new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response;

    // CRYPTO → 1h
    {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fresh());
      const { unmount } = renderWithQuery(
        <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />,
      );
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1h');
      unmount();
      vi.restoreAllMocks();
    }
    // COMMODITIES → 1h (Pyth supports commodity intraday)
    {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fresh());
      renderWithQuery(<MarketChart oracleSymbol="XAUUSD" assetClass="COMMODITIES" />);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1h');
    }
  });

  it('resets tf to a class-supported value on assetClass swap', async () => {
    // Driver swaps {sym, cls} via a button click. The MarketChart
    // instance is preserved (no key change) which simulates Next
    // App Router keeping the client component mounted across
    // navigations. defaultTimeframe is '1h' for all classes; this
    // test verifies the reset still picks a class-supported tf and
    // the new symbol gets a fresh fetch.
    function Driver() {
      const [pair, setPair] = useState<{ sym: string; cls: ChartAssetClass }>({
        sym: 'BTC',
        cls: 'CRYPTO',
      });
      return (
        <>
          <button onClick={() => setPair({ sym: 'XAUUSD', cls: 'COMMODITIES' })}>
            swap
          </button>
          <MarketChart oracleSymbol={pair.sym} assetClass={pair.cls} />
        </>
      );
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response,
    );

    const { findByTestId, getByRole } = renderWithQuery(<Driver />);
    await findByTestId('candlestick-chart');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('s=BTC');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1h');

    // Swap to COMMODITIES — should refetch the new symbol with the
    // default tf=1h (valid for COMMODITIES under Pyth).
    fireEvent.click(getByRole('button', { name: 'swap' }));

    await waitFor(
      () => {
        const lastUrl = String(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0]);
        expect(lastUrl).toContain('s=XAUUSD');
        expect(lastUrl).toContain('tf=1h');
      },
      { timeout: 3000 },
    );
  });

  // Joshua, 2026-10-08: the full chart, in the redesign, on crypto pools and round pages.
  it('an empty answer says there is no price data yet, not that the chart failed', async () => {
    mockChartsFetch({ candles: [] }, 200);
    const { findByText } = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />);
    await findByText('NO PRICE DATA YET', undefined, { timeout: 3000 });
  });

  it('shows the pair and the Rounds timeframes when given, with no caption', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response);
    const { findByText, queryByText, getByRole } = renderWithQuery(
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" timeframes={['1m', '15m', '1h']} initialTimeframe="1m" />,
    );
    await findByText('BTC/USD', undefined, { timeout: 3000 });
    expect(queryByText(/REFERENCE PRICE FROM COINBASE/), 'caption removed (Joshua, 2026-10-08)').toBeNull();
    expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1m');
    expect(getByRole('tab', { name: '1M' }).getAttribute('aria-selected')).toBe('true');
    fetchSpy.mockRestore();
  });

  it('redefines the old colour names to the redesign tokens, so toolbars and menus follow the theme', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES }, 200);
    const { findByText } = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" />);
    const label = await findByText('BTC/USD', undefined, { timeout: 3000 });
    const card = label.closest('div[style*="--color-paper"]') as HTMLElement | null;
    expect(card, 'the chart card carries the theme mapping').not.toBeNull();
    expect(card!.style.getPropertyValue('--color-paper')).toBe('var(--mako-canvas)');
    expect(card!.style.getPropertyValue('--color-ink')).toBe('var(--mako-canvas-fg)');
  });

  it('an active header button stays legible: yellow with a black icon, never the old self-coloured fill', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES }, 200);
    const { findByRole } = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" />);
    const pen = await findByRole('button', { name: 'Open drawing tools' }, { timeout: 3000 });
    expect(pen.style.background).toBe('transparent');
    fireEvent.click(pen);
    const on = await findByRole('button', { name: 'Close drawing tools' });
    expect(on.style.background).toBe('var(--mako-signal)');
    expect(['#000', 'rgb(0, 0, 0)']).toContain(on.style.color);
    expect(on.className).not.toMatch(/bg-ink|text-paper/);
  });

  // Joshua, 2026-10-08: the phone layout, CoinMarketCap-style.
  it('compact: price and 24h change on top, a slim timeframe row, one fullscreen button, no zoom or tools', async () => {
    const day = Array.from({ length: 30 }, (_, i) => ({ timestamp: i * 3600_000, open: 100, high: 112, low: 99, close: i === 29 ? 110 : 100, volume: 1 }));
    mockChartsFetch({ candles: day }, 200);
    const { findByText, getByRole, queryByRole, getByText } = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" compact fullHref="/pools/74/chart" />);
    await findByText('110.00', undefined, { timeout: 3000 });
    expect(getByText('+10.00% 24H')).toBeTruthy();
    expect(getByRole('tab', { name: '1H' }).getAttribute('aria-selected')).toBe('true');
    expect(getByRole('link', { name: 'Open the full chart' }).getAttribute('href')).toBe('/pools/74/chart');
    for (const name of ['Zoom in', 'Zoom out', 'Open drawing tools', 'Indicators menu']) expect(queryByRole('button', { name }), name).toBeNull();
    expect(document.body.textContent).not.toMatch(/REFERENCE PRICE/);
  });

  it('change24h: from the newest candle against the last one at least 24h older; null when the data is shorter', () => {
    const h = (i: number, close: number) => ({ timestamp: i * 3600_000, open: close, high: close, low: close, close, volume: 0 });
    expect(change24h([h(0, 100), h(1, 120), h(24, 90), h(25, 99)])).toBeCloseTo(-17.5); // 25h newest vs 1h (24h before)
    expect(change24h([h(0, 100), h(10, 110)])).toBeNull();
    expect(change24h([])).toBeNull();
  });

  // Joshua, 2026-10-08: opening the chart is a page, not a pop-up.
  it('the full-chart control is a link to the chart page; without one there is no control; page mode has none', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES }, 200);
    const a = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" fullHref="/rounds/3/chart" />);
    const link = await a.findByRole('link', { name: 'Open the full chart' }, { timeout: 3000 });
    expect(link.getAttribute('href')).toBe('/rounds/3/chart');
    expect(a.queryByRole('dialog')).toBeNull();
    cleanup();
    mockChartsFetch({ candles: SAMPLE_CANDLES }, 200);
    const b = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" page fullHref="/rounds/3/chart" />);
    await b.findByText('BTC/USD', undefined, { timeout: 3000 });
    expect(b.queryByRole('link', { name: 'Open the full chart' })).toBeNull();
    expect(b.getByRole('button', { name: 'Open drawing tools' })).toBeTruthy();
  });

  // Joshua, 2026-10-08: "the indicator tab stopped working on mobile". The menu opens, lists the indicators, toggles
  // them, and carries the class that pins it outside the sideways-scrolling toolbar on a phone.
  it('the indicators menu opens and toggles an indicator', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES }, 200);
    const { findByRole, getByRole } = renderWithQuery(<MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" page />);
    fireEvent.click(await findByRole('button', { name: 'Indicators menu' }, { timeout: 3000 }));
    const menu = getByRole('menu', { name: 'Indicators' });
    expect(menu.className).toMatch(/menu/);
    const ma = getByRole('button', { name: /MA \(20\)/ });
    expect(ma.className).not.toMatch(/(^|\s)bg-ink(\s|$)/);
    fireEvent.click(ma);
    expect(getByRole('button', { name: /MA \(20\)/ }).className).toMatch(/(^|\s)bg-ink(\s|$)/);
  });
});
