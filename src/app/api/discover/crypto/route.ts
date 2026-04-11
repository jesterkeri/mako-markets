import { NextResponse } from 'next/server';

/**
 * GET /api/discover/crypto
 *
 * Server-side proxy to CoinGecko's public `/simple/price` endpoint.
 *
 * Why proxy instead of calling CoinGecko from the browser:
 *  - Keeps the request off the venue-Wi-Fi client side (one server call,
 *    many client polls) so we don't burn through CoinGecko's rate limit
 *    from multiple tabs.
 *  - Lets us inject a fallback price if CoinGecko is slow or rate-limited,
 *    so the UI never shows empty cards.
 *  - Would let us swap to a paid provider later without touching the UI.
 *
 * Returns a stable normalized shape:
 *   {
 *     btc: { usd: number, change24h: number },
 *     eth: { usd: number, change24h: number },
 *     sol: { usd: number, change24h: number },
 *     error?: string
 *   }
 */
export const dynamic = 'force-dynamic';

type CoinPrice = { usd: number; change24h: number; testnet?: boolean };
type DiscoverCryptoResponse = {
  btc: CoinPrice;
  eth: CoinPrice;
  sol: CoinPrice;
  mon: CoinPrice;
  error?: string;
};

// Plausible fallbacks for when CoinGecko is unreachable. Not accurate
// but good enough that the create UI stays usable.
//
// MON is pre-mainnet — Monad testnet token has no live USD price. We show
// a placeholder $1.00 with `testnet: true` so the UI can badge it clearly.
// Users can still create markets on MON and override the strike by hand.
const FALLBACK: DiscoverCryptoResponse = {
  btc: { usd: 95000, change24h: 0 },
  eth: { usd: 3500, change24h: 0 },
  sol: { usd: 140, change24h: 0 },
  mon: { usd: 1, change24h: 0, testnet: true },
};

export async function GET(): Promise<NextResponse<DiscoverCryptoResponse>> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,monad&vs_currencies=usd&include_24hr_change=true',
      {
        // Cache on the server for 10s — reduces CoinGecko hits while keeping prices fresh.
        next: { revalidate: 10 },
        headers: { Accept: 'application/json' },
      },
    );

    if (!res.ok) {
      throw new Error(`coingecko responded ${res.status}`);
    }

    const data = (await res.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;

    // If CoinGecko doesn't list Monad (pre-mainnet), `data.monad` will be
    // undefined and we'll fall through to the testnet placeholder.
    const monHasLivePrice = typeof data.monad?.usd === 'number' && data.monad.usd > 0;

    const normalized: DiscoverCryptoResponse = {
      btc: {
        usd: data.bitcoin?.usd ?? FALLBACK.btc.usd,
        change24h: data.bitcoin?.usd_24h_change ?? 0,
      },
      eth: {
        usd: data.ethereum?.usd ?? FALLBACK.eth.usd,
        change24h: data.ethereum?.usd_24h_change ?? 0,
      },
      sol: {
        usd: data.solana?.usd ?? FALLBACK.sol.usd,
        change24h: data.solana?.usd_24h_change ?? 0,
      },
      mon: monHasLivePrice
        ? {
            usd: data.monad!.usd!,
            change24h: data.monad!.usd_24h_change ?? 0,
          }
        : FALLBACK.mon,
    };

    return NextResponse.json(normalized, {
      headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' },
    });
  } catch (err) {
    console.warn('[api/discover/crypto] coingecko fetch failed:', err);
    return NextResponse.json({
      ...FALLBACK,
      error: (err as Error).message,
    });
  }
}
