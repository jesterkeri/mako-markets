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

import { MarketChart } from '../../components/MarketChart';
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

    await findByText('CHART UNAVAILABLE', undefined, { timeout: 3000 });
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

  it('shows daily-only banner for COMMODITIES', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES });
    const { findByText } = renderWithQuery(
      <MarketChart oracleSymbol="XAUUSD" assetClass="COMMODITIES" />,
    );
    await findByText(/DAILY CANDLES ONLY/);
  });

  it('does NOT show daily-only banner for non-COMMODITIES', async () => {
    mockChartsFetch({ candles: SAMPLE_CANDLES });
    const { findByTestId, queryByText } = renderWithQuery(
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" />,
    );
    await findByTestId('candlestick-chart');
    expect(queryByText(/DAILY CANDLES ONLY/)).toBeNull();
  });

  it('defaults to 1h for CRYPTO/FOREX/STOCKS, 1d for COMMODITIES', async () => {
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
    // COMMODITIES → 1d
    {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => fresh());
      renderWithQuery(<MarketChart oracleSymbol="XAUUSD" assetClass="COMMODITIES" />);
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1d');
    }
  });

  it('resets tf when assetClass switches CRYPTO → COMMODITIES (codex r1 MAJOR)', async () => {
    // Driver component to swap assetClass + symbol with the same
    // MarketChart instance preserved (simulating Next App Router
    // preserving client components across `/market/[id]` navigation).
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

    // mockImplementation (not mockResolvedValue) returns a fresh
    // Response per call. Response body is one-shot — a single
    // Response object can only be `.json()`-ed once, which breaks
    // the swap re-fetch.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ candles: SAMPLE_CANDLES }), { status: 200 }) as Response,
    );

    const { findByTestId, findByRole, getByRole } = renderWithQuery(<Driver />);

    // Initial CRYPTO render @ tf=1h
    await findByTestId('candlestick-chart');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('tf=1h');

    // Swap to COMMODITIES — should refetch with tf=1d, NOT tf=1h
    fireEvent.click(getByRole('button', { name: 'swap' }));
    await findByRole('tab', { name: '1D' }, { timeout: 3000 });

    await waitFor(
      () => {
        const lastUrl = String(fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1][0]);
        expect(lastUrl).toContain('s=XAUUSD');
        expect(lastUrl).toContain('tf=1d');
      },
      { timeout: 3000 },
    );

    // No CRYPTO-leftover tf=1h fetch landed on XAUUSD
    const xauusd1hCall = fetchSpy.mock.calls.find((c) => {
      const u = String(c[0]);
      return u.includes('s=XAUUSD') && u.includes('tf=1h');
    });
    expect(xauusd1hCall).toBeUndefined();
  });
});
