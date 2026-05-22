import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Bypass Next's `unstable_cache` wrapper in tests — invoke the
// inner fetcher directly so we can assert end-to-end route
// behaviour without dragging Next's per-request cache machinery
// into vitest. The fetcher we pass is what the route would build
// inside unstable_cache(); the wrapper is transparent.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T) => fn,
}));

// Mock the two upstream fetchers; the route's job is to dispatch
// + map errors. Upstream behaviour is covered in its own tests.
vi.mock('@/lib/chart-providers/twelvedata', async () => {
  const actual = await vi.importActual<
    typeof import('../chart-providers/twelvedata')
  >('../chart-providers/twelvedata');
  return {
    ...actual,
    fetchTwelveDataCandles: vi.fn(),
  };
});

vi.mock('@/lib/chart-providers/stooq', async () => {
  const actual = await vi.importActual<typeof import('../chart-providers/stooq')>(
    '../chart-providers/stooq',
  );
  return {
    ...actual,
    fetchStooqDailyCandles: vi.fn(),
  };
});

// Import AFTER mocks so the route binds to the mocked symbols.
import { GET } from '@/app/api/charts/route';
import {
  fetchTwelveDataCandles,
  TwelveDataApiError,
  TwelveDataRateLimitError,
} from '@/lib/chart-providers/twelvedata';
import {
  fetchStooqDailyCandles,
  StooqApiError,
} from '@/lib/chart-providers/stooq';

const KEY_BEFORE = process.env.TWELVEDATA_API_KEY;

beforeAll(() => {
  process.env.TWELVEDATA_API_KEY = 'test-key';
});

afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.TWELVEDATA_API_KEY;
  else process.env.TWELVEDATA_API_KEY = KEY_BEFORE;
});

beforeEach(() => {
  vi.mocked(fetchTwelveDataCandles).mockReset();
  vi.mocked(fetchStooqDailyCandles).mockReset();
});

function mkReq(qs: string) {
  // Minimal NextRequest stand-in (only `url` is read by the handler).
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

  it('400 commodity + non-1d (XAUUSD with tf=1h)', async () => {
    const res = await GET(mkReq('s=XAUUSD&tf=1h'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'timeframe_not_supported' });
    expect(fetchStooqDailyCandles).not.toHaveBeenCalled();
    expect(fetchTwelveDataCandles).not.toHaveBeenCalled();
  });

  it('200 CRYPTO via TwelveData', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candles: SAMPLE_CANDLES });
    expect(fetchTwelveDataCandles).toHaveBeenCalledWith({
      providerSymbol: 'BTC/USD',
      timeframe: '1h',
    });
  });

  it('200 FOREX via TwelveData', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=EURUSD&tf=15m'));
    expect(res.status).toBe(200);
    expect(fetchTwelveDataCandles).toHaveBeenCalledWith({
      providerSymbol: 'EUR/USD',
      timeframe: '15m',
    });
  });

  it('200 STOCKS via TwelveData', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=AAPL&tf=4h'));
    expect(res.status).toBe(200);
    expect(fetchTwelveDataCandles).toHaveBeenCalledWith({
      providerSymbol: 'AAPL',
      timeframe: '4h',
    });
  });

  it('200 COMMODITIES via Stooq (1d only)', async () => {
    vi.mocked(fetchStooqDailyCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=XAUUSD&tf=1d'));
    expect(res.status).toBe(200);
    expect(fetchStooqDailyCandles).toHaveBeenCalledWith({ providerSymbol: 'xauusd' });
    expect(fetchTwelveDataCandles).not.toHaveBeenCalled();
  });

  it('default tf=1h when omitted', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    await GET(mkReq('s=BTC'));
    expect(fetchTwelveDataCandles).toHaveBeenCalledWith(expect.objectContaining({ timeframe: '1h' }));
  });

  it('symbol uppercased before lookup (btc → BTC)', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=btc&tf=1h'));
    expect(res.status).toBe(200);
    expect(fetchTwelveDataCandles).toHaveBeenCalledWith({
      providerSymbol: 'BTC/USD',
      timeframe: '1h',
    });
  });

  it('503 on TwelveDataRateLimitError', async () => {
    vi.mocked(fetchTwelveDataCandles).mockRejectedValue(new TwelveDataRateLimitError());
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  it('502 on TwelveDataApiError', async () => {
    vi.mocked(fetchTwelveDataCandles).mockRejectedValue(new TwelveDataApiError('bad'));
    const res = await GET(mkReq('s=BTC&tf=1h'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed', provider: 'twelvedata' });
  });

  it('502 on StooqApiError', async () => {
    vi.mocked(fetchStooqDailyCandles).mockRejectedValue(new StooqApiError('throttled'));
    const res = await GET(mkReq('s=XAUUSD&tf=1d'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed', provider: 'stooq' });
  });

  it('cache-control header set on success', async () => {
    vi.mocked(fetchTwelveDataCandles).mockResolvedValue(SAMPLE_CANDLES);
    const res = await GET(mkReq('s=BTC&tf=4h'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  });
});
