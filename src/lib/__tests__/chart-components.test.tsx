// @vitest-environment jsdom
// The price candle chart rendered against /api/charts' real answer shape: it says plainly when data is missing or the
// source failed, never drawing a made-up line.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PriceCandles } from '@/components/charts/PriceCandles';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const answer = (status: number, body: unknown) => vi.fn(async () => ({ ok: status === 200, status, json: async () => body }) as Response);

describe('PriceCandles', () => {
  const candles = [
    { timestamp: 60_000, open: 100, high: 102, low: 99, close: 101, volume: 1 },
    { timestamp: 120_000, open: 101, high: 103, low: 100, close: 102.5, volume: 1 },
  ];

  it('draws candles from /api/charts with the last price tagged, and says it is a reference, not the settlement source', async () => {
    vi.stubGlobal('fetch', answer(200, { candles }));
    wrap(<PriceCandles symbol="BTC" pair="BTC/USD" timeframes={['1m', '1h']} initial="1m" />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'BTC/USD price chart, last 102.50' })).toBeTruthy());
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/charts?s=BTC&tf=1m');
    expect(screen.getByText('REFERENCE PRICE FROM COINBASE · NOT THE SETTLEMENT SOURCE')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a failed read is a plain error; an empty answer says there is no data', async () => {
    vi.stubGlobal('fetch', answer(502, { error: 'upstream_failed' }));
    wrap(<PriceCandles symbol="ETH" pair="ETH/USD" timeframes={['1h']} initial="1h" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Price chart unavailable right now.'));
    cleanup();
    vi.stubGlobal('fetch', answer(200, { candles: [] }));
    wrap(<PriceCandles symbol="ETH" pair="ETH/USD" timeframes={['1h']} initial="1h" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No price data yet.'));
    // One timeframe: no picker.
    expect(screen.queryByRole('group', { name: 'Chart timeframe' })).toBeNull();
  });
});
