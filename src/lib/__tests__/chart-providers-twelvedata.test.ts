import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  fetchTwelveDataCandles,
  TwelveDataApiError,
  TwelveDataRateLimitError,
} from '../chart-providers/twelvedata';

const KEY_BEFORE = process.env.TWELVEDATA_API_KEY;

beforeAll(() => {
  process.env.TWELVEDATA_API_KEY = 'test-key';
});

afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.TWELVEDATA_API_KEY;
  else process.env.TWELVEDATA_API_KEY = KEY_BEFORE;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOk(body: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 }) as Response,
  );
}

function mockFetchStatus(status: number, body?: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body ? JSON.stringify(body) : '', { status }) as Response,
  );
}

const OK_BODY = {
  status: 'ok',
  values: [
    { datetime: '2026-05-22 10:00:00', open: '100', high: '105', low: '99',  close: '104', volume: '1000' },
    { datetime: '2026-05-22 09:00:00', open: '98',  high: '101', low: '97',  close: '100', volume: '900'  },
  ],
};

describe('fetchTwelveDataCandles', () => {
  it('composes URL with symbol, interval, outputsize, timezone=UTC, apikey', async () => {
    let captured: string | URL | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      captured = input as string | URL;
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    });
    await fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' });
    const url = new URL(String(captured));
    expect(url.origin + url.pathname).toBe('https://api.twelvedata.com/time_series');
    expect(url.searchParams.get('symbol')).toBe('BTC/USD');
    expect(url.searchParams.get('interval')).toBe('1h');
    expect(url.searchParams.get('outputsize')).toBe('200');
    expect(url.searchParams.get('timezone')).toBe('UTC');
    expect(url.searchParams.get('apikey')).toBe('test-key');
  });

  it.each([
    { tf: '15m' as const, expected: '15min' },
    { tf: '1h'  as const, expected: '1h' },
    { tf: '4h'  as const, expected: '4h' },
    { tf: '1d'  as const, expected: '1day' },
  ])('maps timeframe $tf → interval $expected', async ({ tf, expected }) => {
    let captured: string | URL | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      captured = input as string | URL;
      return new Response(JSON.stringify(OK_BODY), { status: 200 });
    });
    await fetchTwelveDataCandles({ providerSymbol: 'AAPL', timeframe: tf });
    expect(new URL(String(captured)).searchParams.get('interval')).toBe(expected);
  });

  it('parses ok response into ascending Candle array', async () => {
    mockFetchOk(OK_BODY);
    const candles = await fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' });
    expect(candles).toHaveLength(2);
    // newest-first → ascending: 09:00 first, 10:00 second
    expect(candles[0].timestamp).toBe(new Date('2026-05-22T09:00:00Z').getTime());
    expect(candles[1].timestamp).toBe(new Date('2026-05-22T10:00:00Z').getTime());
    expect(candles[0].open).toBe(98);
    expect(candles[1].close).toBe(104);
  });

  it('parses DAILY response (YYYY-MM-DD, no time part) as UTC midnight', async () => {
    // TwelveData's `1day` interval returns date-only strings.
    // The intraday path (`replace(' ', 'T') + 'Z'`) would produce
    // "2026-05-22Z" which is a non-standard ISO string. Verify the
    // daily branch yields midnight UTC.
    mockFetchOk({
      status: 'ok',
      values: [
        { datetime: '2026-05-22', open: '100', high: '105', low: '99', close: '104' },
        { datetime: '2026-05-21', open: '95',  high: '101', low: '94', close: '100' },
      ],
    });
    const candles = await fetchTwelveDataCandles({ providerSymbol: 'AAPL', timeframe: '1d' });
    expect(candles).toHaveLength(2);
    expect(candles[0].timestamp).toBe(new Date('2026-05-21T00:00:00Z').getTime());
    expect(candles[1].timestamp).toBe(new Date('2026-05-22T00:00:00Z').getTime());
    expect(Number.isFinite(candles[0].timestamp)).toBe(true);
    expect(Number.isFinite(candles[1].timestamp)).toBe(true);
  });

  it('normalizes missing volume to 0', async () => {
    mockFetchOk({
      status: 'ok',
      values: [{ datetime: '2026-05-22 10:00:00', open: '1', high: '1', low: '1', close: '1' }],
    });
    const candles = await fetchTwelveDataCandles({ providerSymbol: 'EUR/USD', timeframe: '1h' });
    expect(candles[0].volume).toBe(0);
  });

  it('throws TwelveDataRateLimitError on HTTP 429', async () => {
    mockFetchStatus(429);
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(TwelveDataRateLimitError);
  });

  it('throws TwelveDataApiError on HTTP 5xx', async () => {
    mockFetchStatus(503);
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(TwelveDataApiError);
  });

  it('throws TwelveDataRateLimitError on body { status:error, code:429 }', async () => {
    mockFetchOk({ status: 'error', code: 429, message: 'You have run out of API credits' });
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(TwelveDataRateLimitError);
  });

  it('throws TwelveDataApiError on body { status:error, code:!=429 }', async () => {
    mockFetchOk({ status: 'error', code: 400, message: 'bad symbol' });
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(TwelveDataApiError);
  });

  it('zod throws on malformed body', async () => {
    mockFetchOk({ status: 'ok', values: 'not-an-array' });
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toThrow();
  });

  it('throws TwelveDataApiError when API key missing', async () => {
    delete process.env.TWELVEDATA_API_KEY;
    await expect(
      fetchTwelveDataCandles({ providerSymbol: 'BTC/USD', timeframe: '1h' }),
    ).rejects.toBeInstanceOf(TwelveDataApiError);
    process.env.TWELVEDATA_API_KEY = 'test-key';
  });
});
