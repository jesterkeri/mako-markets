import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Bypass Next's `unstable_cache` so we test route dispatch directly.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
}));

// Single provider after #166 polish r15 — Pyth Benchmarks handles
// every asset class.
vi.mock('@/lib/chart-providers/pyth', async () => {
  const actual = await vi.importActual<typeof import('../chart-providers/pyth')>(
    '../chart-providers/pyth',
  );
  return {
    ...actual,
    fetchPythCandles: vi.fn(),
  };
});

import { GET } from '@/app/api/charts/route';
import {
  fetchPythCandles,
  PythApiError,
} from '@/lib/chart-providers/pyth';

beforeEach(() => {
  vi.mocked(fetchPythCandles).mockReset();
});

function mkReq(qs: string) {
  return { url: `http://localhost/api/charts?${qs}` } as unknown as import('next/server').NextRequest;
}

const SAMPLE_CANDLES = [
  { timestamp: 1747948800000, open: 1, high: 2, low: 1, close: 2, volume: 0 },
];

describe('GET /api/charts', () => {
  it('400 when `s` is missing', async () => {
    const res = await GET(mkReq('tf=1h'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_params' });
  });

  it('400 when `tf` is invalid', async () => {
    const res = await GET(mkReq('s=BTC&tf=99x'));
    expect(res.status).toBe(400);
  });

  it('404 when symbol is unknown', async () => {
    const res = await GET(mkReq('s=NOTREAL&tf=1h'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_symbol' });
  });

  it('200 CRYPTO routes through Pyth Crypto.<sym>/USD', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candles: SAMPLE_CANDLES });
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'Crypto.BTC/USD',
      timeframe: '1h',
    });
  });

  it('200 FOREX routes through Pyth FX.<base>/<quote>', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=EURUSD&tf=15m'));
    expect(res.status).toBe(200);
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'FX.EUR/USD',
      timeframe: '15m',
    });
  });

  it('200 STOCKS routes through Pyth Equity.US.<ticker>/USD', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=AAPL&tf=4h'));
    expect(res.status).toBe(200);
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'Equity.US.AAPL/USD',
      timeframe: '4h',
    });
  });

  it('200 COMMODITIES routes through Pyth Metal.<sym>/USD (any tf)', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=XAUUSD&tf=1d'));
    expect(res.status).toBe(200);
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'Metal.XAU/USD',
      timeframe: '1d',
    });
  });

  it('200 COMMODITIES on 2h (Pyth supports it, was blocked under Yahoo)', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=XAGUSD&tf=2h'));
    expect(res.status).toBe(200);
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'Metal.XAG/USD',
      timeframe: '2h',
    });
  });

  it('default tf=1h when omitted', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    await GET(mkReq('s=BTC'));
    expect(fetchPythCandles).toHaveBeenCalledWith(expect.objectContaining({ timeframe: '1h' }));
  });

  it('symbol uppercased before lookup (btc → BTC)', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=btc&tf=1h'));
    expect(res.status).toBe(200);
    expect(fetchPythCandles).toHaveBeenCalledWith({
      providerSymbol: 'Crypto.BTC/USD',
      timeframe: '1h',
    });
  });

  it('502 on PythApiError', async () => {
    vi.mocked(fetchPythCandles).mockRejectedValue(new PythApiError('boom'));
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed', provider: 'pyth' });
  });

  it('502 on unknown error', async () => {
    vi.mocked(fetchPythCandles).mockRejectedValue(new Error('boom'));
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed' });
  });

  it('cache-control header set on success', async () => {
    vi.mocked(fetchPythCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=BTC&tf=4h'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  });
});
