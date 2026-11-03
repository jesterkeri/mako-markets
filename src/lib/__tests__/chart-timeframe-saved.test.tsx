// OBS-001 (CryptoTester QA, Joshua 2026-11-03): the timeframe picked on any chart is kept in this browser and every
// chart opens on it; a chart that does not offer it uses its own default; junk in storage is ignored.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/use-chart-colors', async () => {
  const { DEFAULT_CHART_COLORS } = await import('@/lib/chart-colors');
  return { useChartColors: () => ({ colors: DEFAULT_CHART_COLORS, account: null, signedIn: false, loading: false, canSave: false, loadFailed: false, save: () => {}, saveFailed: false }) };
});
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: ({ timeframe }: { timeframe: string }) => <div data-testid="candlestick-chart" data-timeframe={timeframe} />,
}));

import { MarketChart } from '../../components/MarketChart';

const KEY = 'mako:chart:timeframe';
const CANDLES = [
  { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 },
  { timestamp: 1_700_003_600_000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 0 },
];
const tab = (name: string) => screen.findByRole('tab', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function show(ui: React.ReactElement) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: CANDLES }), { status: 200 }) as Response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const lastTf = () => {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return new URL(String(calls[calls.length - 1][0]), 'http://x').searchParams.get('tf');
};

const pool = <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" page />;
const round = <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" timeframes={['1m', '15m', '1h']} initialTimeframe="1m" page />;

describe('saved chart timeframe', () => {
  it('a pick is saved and the next chart opens on it, after a refresh too', async () => {
    show(pool);
    await waitFor(() => expect(lastTf()).toBe('1h'));
    fireEvent.click(await tab('4H'));
    await waitFor(() => expect(lastTf()).toBe('4h'));
    expect(window.localStorage.getItem(KEY)).toBe('4h');
    cleanup();
    vi.restoreAllMocks();
    show(pool);
    await waitFor(() => expect(lastTf()).toBe('4h'));
    expect((await tab('4H')).getAttribute('aria-selected')).toBe('true');
  });

  it('a chart that does not offer the saved timeframe uses its own default', async () => {
    window.localStorage.setItem(KEY, '4h');
    show(round);
    await waitFor(() => expect(lastTf()).toBe('1m'));
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.setItem(KEY, '1m');
    show(pool);
    await waitFor(() => expect(lastTf()).toBe('1h'));
  });

  it('a timeframe offered by both carries over (15m from a round to a pool)', async () => {
    show(round);
    fireEvent.click(await tab('15M'));
    await waitFor(() => expect(lastTf()).toBe('15m'));
    cleanup();
    vi.restoreAllMocks();
    show(pool);
    await waitFor(() => expect(lastTf()).toBe('15m'));
  });

  it('junk in storage is ignored', async () => {
    for (const junk of ['5m', '1H', '', '1h ', '<img>']) {
      window.localStorage.setItem(KEY, junk);
      show(pool);
      await waitFor(() => expect(lastTf()).toBe('1h'));
      cleanup();
      vi.restoreAllMocks();
    }
  });

  it('with storage blocked, the pick still applies in this tab', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    show(pool);
    fireEvent.click(await tab('2H'));
    await waitFor(() => expect(lastTf()).toBe('2h'));
  });
});
