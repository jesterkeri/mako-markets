// @vitest-environment jsdom
// The two design charts rendered against their APIs' real answer shapes: the YES share chart ends at the contract's
// share now; both say plainly when data is missing or the source failed, never drawing a made-up line.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PriceCandles } from '@/components/charts/PriceCandles';
import { chainShareBps, shareTicks, YesShareChart } from '@/components/charts/YesShareChart';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const answer = (status: number, body: unknown) => vi.fn(async () => ({ ok: status === 200, status, json: async () => body }) as Response);

describe('YesShareChart', () => {
  it('draws the history and tags the share the contract holds now', async () => {
    vi.stubGlobal('fetch', answer(200, { points: [{ t: 1000, yesBps: 10000 }, { t: 2000, yesBps: 5000 }, { t: 3000, yesBps: 7500 }], bets: 3, indexedYes: '3000000', indexedNo: '1000000' }));
    // Contract now: 3 YES, 1 NO -> 75%, the same totals the indexer has.
    wrap(<YesShareChart marketId={93n} openedAt={1000} now={4000} chainYes={3_000_000n} chainNo={1_000_000n} />);
    await waitFor(() => expect(screen.getByRole('img', { name: /now 75%/ })).toBeTruthy());
    expect(screen.getByText(/YES.75%/)).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/pools/93/history');
  });

  it('while the indexer is behind the contract it says it is catching up, and draws nothing', async () => {
    vi.stubGlobal('fetch', answer(200, { points: [{ t: 1000, yesBps: 10000 }], bets: 1, indexedYes: '1000000', indexedNo: '0' }));
    wrap(<YesShareChart marketId={9n} openedAt={1000} now={90_000} chainYes={1_000_000n} chainNo={3_000_000n} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Catching up with the latest bet…'));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('an answer without the indexed totals is an error, never drawn', async () => {
    vi.stubGlobal('fetch', answer(200, { points: [{ t: 1000, yesBps: 10000 }], bets: 1 }));
    wrap(<YesShareChart marketId={9n} openedAt={1000} now={2000} chainYes={1n} chainNo={0n} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Share history unavailable right now.'));
  });

  it('an empty pool says so without asking for history to draw', () => {
    vi.stubGlobal('fetch', answer(200, { points: [], bets: 0 }));
    wrap(<YesShareChart marketId={1n} openedAt={1000} now={2000} chainYes={0n} chainNo={0n} />);
    expect(screen.getByRole('status').textContent).toBe('No bets yet. The chart starts with the first bet.');
  });

  it('a failed history read is a plain error, not a line', async () => {
    vi.stubGlobal('fetch', answer(502, { error: 'upstream_failed' }));
    wrap(<YesShareChart marketId={1n} openedAt={1000} now={2000} chainYes={1n} chainNo={1n} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Share history unavailable right now.'));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('ticks: clock times for a young pool, weekdays for an older one, always ending NOW', () => {
    expect(shareTicks(0, 3600)).toHaveLength(5);
    expect(shareTicks(0, 3600).at(-1)).toBe('NOW');
    expect(shareTicks(0, 3600)[0]).toMatch(/^\d\d:\d\d$/);
    expect(shareTicks(0, 5 * 86400)[1]).toMatch(/^[A-Z]{3}$/);
    expect(chainShareBps(1n, 2n)).toBe(3333);
    expect(chainShareBps(0n, 0n)).toBeNull();
  });
});

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
