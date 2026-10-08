// @vitest-environment jsdom
// Adversary on 015c0e2 (YES share chart and Coinbase candles), against the owner's spec of 2026-10-08:
//  1. "/api/pools/[id]/history ... must REFUSE (error, never a partial or wrong series) any answer whose bets do not
//     add up to the pool's totals ... Share must never be shown larger than it is."
//  2. "Any malformed or impossible upstream row must make the request fail (502), never be drawn."
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { YesShareChart } from '@/components/charts/YesShareChart';
import { CoinbaseApiError, fetchCoinbaseCandles } from '@/lib/chart-providers/coinbase';
import { fetchPoolHistory } from '@/lib/pool-history';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

describe('YES share chart when the indexer is behind the contract', () => {
  it('does not draw a series whose bets do not add up to the totals the contract holds now', async () => {
    // The indexer has the creator's 1 USDC YES seed at t=1000 and nothing after it. Its answer is self-consistent, so
    // the route's own checks pass: this is the exact body fetchPoolHistory builds for it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { Bet: [{ amount: '1000000', isYes: true, timestamp: 1000 }], Pool: [{ totalYes: '1000000', totalNo: '0', betCount: 1 }] } }) }) as Response),
    );
    const body = await fetchPoolHistory('https://indexer.invalid/graphql', 9n);
    expect(body).toEqual({ points: [{ t: 1000, yesBps: 10000 }], bets: 1, indexedYes: '1000000', indexedNo: '0' });

    // On chain a 3 USDC NO bet has since landed (indexer stalled): the pool is 1 YES / 3 NO, YES 25% since then.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response));
    wrap(<YesShareChart marketId={9n} openedAt={1000} now={90_000} chainYes={1_000_000n} chainNo={3_000_000n} />);

    // The indexed bets (1 YES, 0 NO) do not add up to the pool's totals (1 YES, 3 NO): the spec says refuse, so the
    // chart must show a plain message, not a line that holds YES at 100% until "now" while the pool is at 25%.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Loading share history/)).toBeNull());
    // The drawn line, if any: y 0 is YES 100%, y 120 is YES 25%; x 600 is "now".
    const line = document.querySelector('path[fill="none"]')?.getAttribute('d') ?? null;
    expect(line, 'a share line was drawn from an answer that does not add up to the pool totals').toBeNull();
  });
});

describe('Coinbase candles: an impossible row is refused, never drawn', () => {
  const H = 3600;
  const ok = (rows: unknown) => vi.fn(async () => ({ ok: true, status: 200, json: async () => rows }) as Response);

  it('refuses a 1h answer whose rows are not on the hour (Coinbase 1h candles start on the hour)', async () => {
    // Newest first, each row internally valid, but spaced one minute apart and off the hourly grid: not 1h candles.
    const t = 480_000 * H + 30;
    vi.stubGlobal('fetch', ok([[t + 60, 99, 106, 100, 105, 2], [t, 95, 101, 97, 100, 1]]));
    await expect(fetchCoinbaseCandles({ product: 'BTC-USD', timeframe: '1h' })).rejects.toThrow(CoinbaseApiError);
  });

  it('refuses a candle dated in the future', async () => {
    const future = (Math.floor(Date.now() / 1000 / H) + 24 * 365) * H; // one year ahead, on the hour
    vi.stubGlobal('fetch', ok([[future, 99, 106, 100, 105, 2]]));
    await expect(fetchCoinbaseCandles({ product: 'BTC-USD', timeframe: '1h' })).rejects.toThrow(CoinbaseApiError);
  });
});
