// Adversary pass on OBS-001 (a4d7c11). Spec A3: "Blocked or throwing storage (private mode) must not crash the
// page; the pick still applies in the open tab." Storage that reads fine but refuses writes (Safari private mode
// before 11, or a full quota: setItem throws QuotaExceededError while getItem still answers) must keep the pick too.
//
// The storage is replaced on window rather than spied on Storage.prototype: happy-dom's localStorage does not route
// every call through the prototype, so a prototype spy can silently not apply.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
let stored: Record<string, string> = {};
let setCalls = 0;

// Reads answer from `stored`; every write throws, as a full quota does.
const readOnlyStorage = {
  getItem: (k: string) => (k in stored ? stored[k] : null),
  setItem: () => {
    setCalls += 1;
    throw new DOMException('quota', 'QuotaExceededError');
  },
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(async () => {
  vi.resetModules();
  ({ MarketChart } = await import('../../components/MarketChart'));
  stored = {};
  setCalls = 0;
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => readOnlyStorage });
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

describe('A3: storage that reads but refuses writes', () => {
  it('nothing saved yet: picking 2H shows 2H in this tab', async () => {
    show();
    await waitFor(() => expect(shown()).toBe('1h'));
    fireEvent.click(await screen.findByRole('tab', { name: '2H' }));
    expect(setCalls).toBe(1); // the write was attempted and refused
    await waitFor(() => expect(shown()).toBe('2h'));
  });

  it('an older pick (4h) is stored: picking 2H shows 2H in this tab', async () => {
    stored[KEY] = '4h';
    show();
    await waitFor(() => expect(shown()).toBe('4h'));
    fireEvent.click(await screen.findByRole('tab', { name: '2H' }));
    expect(setCalls).toBe(1);
    await waitFor(() => expect(shown()).toBe('2h'));
  });
});
