// GET /api/charts: crypto candles from Coinbase; forex, commodities and stocks have no free source and answer 404.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Bypass Next's `unstable_cache` so route dispatch is tested directly.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
}));

vi.mock('@/lib/chart-providers/coinbase', async () => {
  const actual = await vi.importActual<typeof import('../chart-providers/coinbase')>('../chart-providers/coinbase');
  return { ...actual, fetchCoinbaseCandles: vi.fn() };
});

import { GET } from '@/app/api/charts/route';
import { CoinbaseApiError, fetchCoinbaseCandles } from '@/lib/chart-providers/coinbase';

beforeEach(() => {
  vi.mocked(fetchCoinbaseCandles).mockReset();
});

function mkReq(qs: string) {
  return { url: `http://localhost/api/charts?${qs}` } as unknown as import('next/server').NextRequest;
}

const SAMPLE = [{ timestamp: 1747948800000, open: 1, high: 2, low: 1, close: 2, volume: 3 }];

describe('GET /api/charts', () => {
  it('400 when `s` is missing or `tf` is invalid', async () => {
    expect((await GET(mkReq('tf=1h'))).status).toBe(400);
    expect((await GET(mkReq('s=BTC&tf=3h'))).status).toBe(400);
  });

  it('404 unknown_symbol for a symbol not on the chart list', async () => {
    const res = await GET(mkReq('s=NOPE'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_symbol' });
  });

  it('404 no_chart_source for forex, commodities and stocks, without calling Coinbase', async () => {
    for (const s of ['EURUSD', 'XAUUSD', 'AAPL']) {
      const res = await GET(mkReq(`s=${s}`));
      expect(res.status, s).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_chart_source' });
    }
    expect(fetchCoinbaseCandles).not.toHaveBeenCalled();
  });

  it('200 crypto routes to the Coinbase <SYM>-USD product, symbol case-insensitive, default 1h', async () => {
    vi.mocked(fetchCoinbaseCandles).mockResolvedValue(SAMPLE);
    const res = await GET(mkReq('s=btc'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candles: SAMPLE });
    expect(fetchCoinbaseCandles).toHaveBeenCalledWith({ product: 'BTC-USD', timeframe: '1h' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('1m is accepted for the Rounds chart, with a short cache', async () => {
    vi.mocked(fetchCoinbaseCandles).mockResolvedValue(SAMPLE);
    const res = await GET(mkReq('s=BTC&tf=1m'));
    expect(res.status).toBe(200);
    expect(fetchCoinbaseCandles).toHaveBeenCalledWith({ product: 'BTC-USD', timeframe: '1m' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=30');
  });

  it('503 rate_limited on a Coinbase 429, 502 on any other failure', async () => {
    vi.mocked(fetchCoinbaseCandles).mockRejectedValue(new CoinbaseApiError('status 429', 429));
    const limited = await GET(mkReq('s=ETH'));
    expect(limited.status).toBe(503);
    expect(limited.headers.get('retry-after')).toBe('30');
    vi.mocked(fetchCoinbaseCandles).mockRejectedValue(new CoinbaseApiError('malformed candle'));
    expect((await GET(mkReq('s=ETH'))).status).toBe(502);
    vi.mocked(fetchCoinbaseCandles).mockRejectedValue(new Error('boom'));
    expect((await GET(mkReq('s=ETH'))).status).toBe(502);
  });
});
