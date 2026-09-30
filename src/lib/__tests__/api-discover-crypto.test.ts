// GET /api/discover/crypto returns live prices only. It used to fill any symbol CoinGecko did not price, and
// every symbol when CoinGecko failed, with a hard-coded "plausible" price and a 0% change; the create page set
// price-market strikes from those. A missing price is now reported as unavailable, never guessed.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../../app/api/discover/crypto/route';
import { CRYPTO_ASSETS } from '../crypto-assets';

const ALL = CRYPTO_ASSETS.map((a) => a.symbol);

function coingecko(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/discover/crypto', () => {
  it('returns the live prices it got and lists the rest as unavailable, never a guess', async () => {
    coingecko({ bitcoin: { usd: 76012.5, usd_24h_change: 1.84 }, ethereum: { usd: 2750.68, usd_24h_change: -0.5 } });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prices).toEqual({
      BTC: { usd: 76012.5, change24h: 1.84 },
      ETH: { usd: 2750.68, change24h: -0.5 },
    });
    expect(body.unavailable).toEqual(ALL.filter((s) => s !== 'BTC' && s !== 'ETH'));
    // The old fallbacks (BTC 95000, MON 1) appear nowhere.
    expect(JSON.stringify(body)).not.toMatch(/95000|"usd":1\b/);
  });

  it('reports a missing 24h change as null, not as 0%', async () => {
    coingecko({ bitcoin: { usd: 76012.5 } });
    const body = await (await GET()).json();
    expect(body.prices.BTC).toEqual({ usd: 76012.5, change24h: null });
  });

  it('treats a zero, negative or non-numeric price as unavailable', async () => {
    coingecko({ bitcoin: { usd: 0 }, ethereum: { usd: -3 }, solana: { usd: 'x' }, near: { usd: 4.03 } });
    const body = await (await GET()).json();
    expect(Object.keys(body.prices)).toEqual(['NEAR']);
    expect(body.unavailable).toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL']));
  });

  it('keeps the testnet flag on MON when CoinGecko prices it', async () => {
    coingecko({ monad: { usd: 0.042, usd_24h_change: 3 } });
    const body = await (await GET()).json();
    expect(body.prices.MON).toEqual({ usd: 0.042, change24h: 3, testnet: true });
  });

  it.each([
    ['CoinGecko rate-limits (429)', () => coingecko({}, { ok: false, status: 429 })],
    ['the request throws', () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))],
    ['CoinGecko answers with no priced symbol', () => coingecko({})],
  ])('answers 502 with every symbol unavailable when %s', async (_, arrange) => {
    arrange();
    const res = await GET();
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ prices: {}, unavailable: ALL, error: 'prices_unavailable' });
  });
});
