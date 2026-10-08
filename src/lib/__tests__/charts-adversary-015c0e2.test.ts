// Adversary on 015c0e2 (Coinbase candles), against the owner's spec of 2026-10-08: "Any malformed or impossible
// upstream row must make the request fail (502), never be drawn." (Its YES-share case went with that chart.)
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoinbaseApiError, fetchCoinbaseCandles } from '@/lib/chart-providers/coinbase';

afterEach(() => {
  vi.unstubAllGlobals();
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
