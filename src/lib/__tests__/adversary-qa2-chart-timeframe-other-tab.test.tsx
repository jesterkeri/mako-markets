// Adversary pass 2 on OBS-001 (b68b1f8). Spec A3: storage that throws on read must not crash, and "a pick made in
// another tab that saved successfully should take effect here". The storage event already carries the saved value
// (newValue), so this tab does not need to read storage to learn it.
//
// The storage is replaced on window rather than spied on Storage.prototype: happy-dom's localStorage does not route
// every call through the prototype, so a prototype spy can silently not apply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/use-chart-colors', async () => {
  const { DEFAULT_CHART_COLORS } = await import('@/lib/chart-colors');
  return { useChartColors: () => ({ colors: DEFAULT_CHART_COLORS, account: null, signedIn: false, loading: false, canSave: false, loadFailed: false, save: () => {}, saveFailed: false }) };
});
vi.mock('@/components/chart/CandlestickChart', () => ({
  CandlestickChart: ({ timeframe }: { timeframe: string }) => <div data-testid="candlestick-chart" data-timeframe={timeframe} />,
}));

// A fresh module per test: the pick lives in module memory, as it does for one page load in a browser.
let MarketChart: typeof import('../../components/MarketChart').MarketChart;

const KEY = 'mako:chart:timeframe';
const CANDLES = [
  { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 0 },
  { timestamp: 1_700_003_600_000, open: 100.5, high: 102, low: 100, close: 101.5, volume: 0 },
];

const realStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

// Every read throws (blocked storage); writes are accepted.
const unreadableStorage = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(async () => {
  vi.resetModules();
  ({ MarketChart } = await import('../../components/MarketChart'));
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => unreadableStorage });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (realStorage) Object.defineProperty(window, 'localStorage', realStorage);
});

function show() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ candles: CANDLES }), { status: 200 }) as Response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MarketChart oracleSymbol="BTC" assetClass="CRYPTO" pair="BTC/USD" page />
    </QueryClientProvider>,
  );
}

const shown = () => screen.getByTestId('candlestick-chart').getAttribute('data-timeframe');

describe('A3: storage that throws on read, another tab saves a pick', () => {
  it('the other tab saved 4h: this chart moves to 4H', async () => {
    show();
    await waitFor(() => expect(shown()).toBe('1h'));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, oldValue: null, newValue: '4h' }));
    });
    await waitFor(() => expect(shown()).toBe('4h'));
  });
});
