import { NextResponse } from 'next/server';
import { CRYPTO_ASSETS, type CryptoSymbol } from '@/lib/crypto-assets';

/**
 * GET /api/discover/crypto
 *
 * Server-side proxy to CoinGecko's public `/simple/price` endpoint. Which symbols are fetched, and how they are
 * labelled, is driven by `src/lib/crypto-assets.ts`.
 *
 * Why proxy instead of calling CoinGecko from the browser:
 *  - Keeps the request off the client so many tabs do not burn CoinGecko's rate limit.
 *  - Would let a paid provider replace it later without touching the UI.
 *
 * Only live prices are returned. A symbol CoinGecko did not price is listed in `unavailable`, never filled with
 * a guess: the old per-symbol "plausible fallback" (BTC 95000, MON 1, change 0) made a CoinGecko outage look
 * like live data, and the create page set price-market strikes from it. A failed fetch answers 502 with every
 * symbol unavailable.
 *
 * Response shape:
 *   {
 *     prices: { BTC: { usd, change24h }, ..., MON: { usd, change24h, testnet: true } },  // live only
 *     unavailable: ['APT', ...],                                                            // no live price
 *     error?: 'prices_unavailable'
 *   }
 *   change24h is null when CoinGecko priced the symbol but gave no 24h change.
 */

export const dynamic = 'force-dynamic';

export type CoinPrice = { usd: number; change24h: number | null; testnet?: boolean };
export type DiscoverCryptoResponse = {
  prices: Partial<Record<CryptoSymbol, CoinPrice>>;
  unavailable: CryptoSymbol[];
  error?: 'prices_unavailable';
};

const ALL_SYMBOLS = CRYPTO_ASSETS.map((a) => a.symbol);

function unavailableResponse(): NextResponse<DiscoverCryptoResponse> {
  return NextResponse.json(
    { prices: {}, unavailable: ALL_SYMBOLS, error: 'prices_unavailable' },
    { status: 502, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function GET(): Promise<NextResponse<DiscoverCryptoResponse>> {
  const ids = CRYPTO_ASSETS.map((a) => a.coingeckoId).join(',');
  let data: Record<string, { usd?: number; usd_24h_change?: number } | undefined>;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      {
        // Cached on the server for 10s: fewer CoinGecko hits, prices still fresh for prediction markets.
        next: { revalidate: 10 },
        headers: { Accept: 'application/json' },
      },
    );
    if (!res.ok) {
      console.warn('[api/discover/crypto] coingecko responded', res.status);
      return unavailableResponse();
    }
    data = (await res.json()) as typeof data;
  } catch (err) {
    console.warn('[api/discover/crypto] coingecko fetch failed:', (err as Error).name);
    return unavailableResponse();
  }

  const prices: Partial<Record<CryptoSymbol, CoinPrice>> = {};
  const unavailable: CryptoSymbol[] = [];
  for (const asset of CRYPTO_ASSETS) {
    const row = data?.[asset.coingeckoId];
    const usd = row?.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
      unavailable.push(asset.symbol);
      continue;
    }
    const change = row?.usd_24h_change;
    prices[asset.symbol] = {
      usd,
      change24h: typeof change === 'number' && Number.isFinite(change) ? change : null,
      ...(asset.testnet ? { testnet: true } : {}),
    };
  }

  if (Object.keys(prices).length === 0) return unavailableResponse();

  return NextResponse.json(
    { prices, unavailable },
    { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } },
  );
}
