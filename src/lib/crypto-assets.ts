/**
 * Single source of truth for crypto market symbols Mako supports.
 *
 * Keep the list here and let consumers map off it:
 *   - src/app/api/discover/crypto/route.ts   (CoinGecko ids param, response shape)
 *   - src/components/PriceTicker.tsx         (ticker columns, ordering)
 *   - src/app/create/page.tsx (CryptoTab)    (dropdown options, live-price display)
 *
 * Note: the `.mts` scripts under /scripts (seed-crypto, auto-resolver) can't
 * import from here without running into the tsx CJS/ESM boundary quirks the
 * existing seed.mts documents. Those scripts inline-duplicate the symbol
 * list on purpose — if you add/remove an asset here, mirror the change in:
 *   - scripts/auto-resolver.mts (CryptoSymbol type + parseCryptoOracleRef whitelist + CoinGecko ids)
 *   - scripts/seed-crypto.mts   (PRICE_ROWS)
 *
 * Grep for `MIRROR_CRYPTO_ASSETS` to find every site that must stay in sync.
 */

export type CryptoSymbol =
  | 'BTC'
  | 'ETH'
  | 'SOL'
  | 'AVAX'
  | 'NEAR'
  | 'APT'
  | 'SUI'
  | 'DOGE'
  | 'LINK'
  | 'MON';

export interface CryptoAsset {
  symbol: CryptoSymbol;
  label: string;
  coingeckoId: string;
  // Lower value = appears earlier in the ticker / dropdown. Kept explicit
  // so MON stays last (testnet) and majors lead.
  priority: number;
  // MON pre-mainnet has no real CoinGecko price. The discover route still
  // surfaces the row, tagged so the UI can badge it instead of showing %.
  testnet?: boolean;
}

export const CRYPTO_ASSETS: readonly CryptoAsset[] = [
  { symbol: 'BTC', label: 'Bitcoin', coingeckoId: 'bitcoin', priority: 1 },
  { symbol: 'ETH', label: 'Ethereum', coingeckoId: 'ethereum', priority: 2 },
  { symbol: 'SOL', label: 'Solana', coingeckoId: 'solana', priority: 3 },
  { symbol: 'AVAX', label: 'Avalanche', coingeckoId: 'avalanche-2', priority: 4 },
  { symbol: 'NEAR', label: 'NEAR Protocol', coingeckoId: 'near', priority: 5 },
  { symbol: 'APT', label: 'Aptos', coingeckoId: 'aptos', priority: 6 },
  { symbol: 'SUI', label: 'Sui', coingeckoId: 'sui', priority: 7 },
  { symbol: 'DOGE', label: 'Dogecoin', coingeckoId: 'dogecoin', priority: 8 },
  { symbol: 'LINK', label: 'Chainlink', coingeckoId: 'chainlink', priority: 9 },
  { symbol: 'MON', label: 'Monad', coingeckoId: 'monad', priority: 10, testnet: true },
] as const;

export const CRYPTO_SYMBOLS: readonly CryptoSymbol[] = CRYPTO_ASSETS.map(
  (a) => a.symbol,
);

const SYMBOL_INDEX = new Map<CryptoSymbol, CryptoAsset>(
  CRYPTO_ASSETS.map((a) => [a.symbol, a]),
);

export function getAssetBySymbol(symbol: string): CryptoAsset | undefined {
  return SYMBOL_INDEX.get(symbol as CryptoSymbol);
}

export function isCryptoSymbol(s: string): s is CryptoSymbol {
  return SYMBOL_INDEX.has(s as CryptoSymbol);
}

export function coingeckoIdsCsv(): string {
  return CRYPTO_ASSETS.map((a) => a.coingeckoId).join(',');
}

/**
 * Round a strike price with precision that matches the asset's scale.
 *
 * Integer rounding on a sub-dollar asset like DOGE ($0.10) collapses to $0,
 * which (a) trivializes the market and (b) hits the resolver's
 * `strike <= 0` reject branch, stranding the market until forceRefund.
 * Keep at least two significant figures everywhere — callers in the
 * /create UI and seed scripts both rely on this.
 *
 * NOTE: scripts/seed-crypto.mts inline-duplicates this same function
 * because tsx can't import from src/lib cleanly. If you change this
 * precision ladder, mirror it there. Grep: MIRROR_CRYPTO_ASSETS.
 */
export function roundStrike(spot: number): number {
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  if (spot >= 100) return Math.round(spot); // $100+: dollar precision
  if (spot >= 10) return Math.round(spot * 10) / 10; // $10+: 1 decimal
  if (spot >= 1) return Math.round(spot * 100) / 100; // $1+: 2 decimals
  if (spot >= 0.1) return Math.round(spot * 1000) / 1000; // $0.10+: 3 decimals
  if (spot >= 0.01) return Math.round(spot * 10_000) / 10_000; // $0.01+: 4
  return Math.round(spot * 1_000_000) / 1_000_000; // sub-cent: 6 decimals
}

/**
 * Human-facing strike string. Uses locale formatting for USD-sized assets
 * and a raw decimal for sub-dollar assets (toLocaleString drops the
 * trailing zeros on 0.103 which misreads as "0.103" — fine — but on 0.10
 * it returns "0.1" which reads odd for a strike price). Both callers of
 * this share the same behavior.
 */
export function formatStrikeForDisplay(strike: number): string {
  if (strike >= 1) return strike.toLocaleString();
  return strike.toString();
}
