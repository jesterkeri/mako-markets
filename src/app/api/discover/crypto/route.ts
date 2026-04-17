import { NextResponse } from 'next/server';
import { CRYPTO_ASSETS, type CryptoSymbol } from '@/lib/crypto-assets';

/**
 * GET /api/discover/crypto
 *
 * Server-side proxy to CoinGecko's public `/simple/price` endpoint. Which
 * symbols we fetch — and how they're labeled in the response — is driven
 * entirely by `src/lib/crypto-assets.ts`. Adding a new asset is a one-line
 * change there; this route picks it up automatically.
 *
 * Why proxy instead of calling CoinGecko from the browser:
 *  - Keeps the request off the client side so we don't burn through
 *    CoinGecko's rate limit from many tabs.
 *  - Lets us inject a per-symbol fallback if CoinGecko is slow or rate-
 *    limited, so the UI never shows empty cards.
 *  - Would let us swap to a paid provider later without touching the UI.
 *
 * Response shape:
 *   {
 *     prices: {
 *       BTC: { usd: number, change24h: number },
 *       ETH: { usd: number, change24h: number },
 *       ...
 *       MON: { usd: number, change24h: number, testnet: true }
 *     },
 *     error?: string
 *   }
 */
export const dynamic = 'force-dynamic';

export type CoinPrice = { usd: number; change24h: number; testnet?: boolean };
export type DiscoverCryptoResponse = {
  prices: Partial<Record<CryptoSymbol, CoinPrice>>;
  error?: string;
};

// Per-symbol plausible fallbacks when CoinGecko is unreachable. Chosen
// to be approximately correct so the create UI stays usable even during
// an outage. MON is pre-mainnet → testnet flag forwarded to the client.
const FALLBACK_USD: Record<CryptoSymbol, number> = {
  BTC: 95000,
  ETH: 3500,
  SOL: 140,
  AVAX: 30,
  NEAR: 5,
  APT: 9,
  SUI: 3,
  DOGE: 0.15,
  LINK: 15,
  MON: 1,
};

function buildFallback(): Partial<Record<CryptoSymbol, CoinPrice>> {
  const out: Partial<Record<CryptoSymbol, CoinPrice>> = {};
  for (const asset of CRYPTO_ASSETS) {
    out[asset.symbol] = {
      usd: FALLBACK_USD[asset.symbol],
      change24h: 0,
      ...(asset.testnet ? { testnet: true } : {}),
    };
  }
  return out;
}

export async function GET(): Promise<NextResponse<DiscoverCryptoResponse>> {
  const ids = CRYPTO_ASSETS.map((a) => a.coingeckoId).join(',');
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
      {
        // Cache on the server for 10s — reduces CoinGecko hits while keeping
        // prices fresh. The ticker polls every 10s client-side, so real lag
        // is up to 20s end-to-end. Fine for prediction markets.
        next: { revalidate: 10 },
        headers: { Accept: 'application/json' },
      },
    );
    if (!res.ok) {
      throw new Error(`coingecko responded ${res.status}`);
    }
    const data = (await res.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number } | undefined
    >;

    // Walk the registry; populate per-symbol. A given symbol missing from
    // CoinGecko (Monad pre-mainnet, or any asset de-listed upstream) falls
    // back to our cached plausible value so the UI stays populated.
    const prices: Partial<Record<CryptoSymbol, CoinPrice>> = {};
    for (const asset of CRYPTO_ASSETS) {
      const row = data[asset.coingeckoId];
      const hasLive = typeof row?.usd === 'number' && (row!.usd as number) > 0;
      if (hasLive) {
        prices[asset.symbol] = {
          usd: row!.usd!,
          change24h: row!.usd_24h_change ?? 0,
          ...(asset.testnet ? { testnet: true } : {}),
        };
      } else {
        prices[asset.symbol] = {
          usd: FALLBACK_USD[asset.symbol],
          change24h: 0,
          ...(asset.testnet ? { testnet: true } : {}),
        };
      }
    }

    return NextResponse.json(
      { prices },
      {
        headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
      },
    );
  } catch (err) {
    console.warn('[api/discover/crypto] coingecko fetch failed:', err);
    return NextResponse.json({
      prices: buildFallback(),
      error: (err as Error).message,
    });
  }
}
