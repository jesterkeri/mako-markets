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
 * Two Cloudflare Workers also carry the list and cannot import from here:
 *   - cf-worker/src/index.ts     (CRYPTO_SYMBOLS + COINGECKO_ID_BY_SYMBOL)
 *   - watchdog/src/assets.ts     (CRYPTO_SYMBOLS; its assets-drift test
 *                                 fails if this file and that copy differ)
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

/**
 * Human-facing live price string. Aims for ~5 significant figures across
 * the whole range we care about (BTC five-digit through micro-cap).
 *
 *   $76,391         BTC           (>=10000, integer)
 *   $2,398.45       ETH           (>=1000,  2 decimals)
 *   $89.054         SOL           (>=10,    3 decimals)
 *   $9.7054         LINK          (>=1,     4 decimals)
 *   $0.10247        DOGE          (>=0.1,   5 decimals)
 *   $0.041234       MON           (>=0.01,  6 decimals)
 *   $0.0₄1234       micro-cap     (<0.0001, subscript notation)
 *
 * The subscript notation ("$0.0ₙX") is the DexScreener / CoinGecko
 * convention for prices with 4+ leading zeros after the decimal. `n` is
 * the total count of zeros between the decimal point and the first
 * significant digit; the trailing digits are the first ~3 significant
 * figures with redundant trailing zeros trimmed.
 *
 * Uses `minimumFractionDigits: 2` as a floor so "$9.7" displays as
 * "$9.70" and "$0.1" as "$0.10" — CoinGecko occasionally returns values
 * that round-trip to whole-ish numbers at the API boundary, and a bare
 * "$0.1" reads as sloppy for a market with real money on the line.
 */
export function formatPriceUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '—';
  if (usd === 0) return '$0';

  if (usd < 0.0001) return formatMicroPriceUsd(usd);

  let max: number;
  if (usd >= 10000) max = 0;
  else if (usd >= 1000) max = 2;
  else if (usd >= 100) max = 3;
  else if (usd >= 10) max = 4;
  else if (usd >= 1) max = 5;
  else if (usd >= 0.1) max = 6;
  else if (usd >= 0.01) max = 7;
  else max = 8;

  const min = max === 0 ? 0 : 2;
  return `$${usd.toLocaleString(undefined, {
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  })}`;
}

const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

function formatMicroPriceUsd(usd: number): string {
  // toFixed(20) gives us enough trailing digits to reliably extract the
  // leading-zero run plus a few sig figs, without float-repr surprises.
  const str = usd.toFixed(20);
  const dot = str.indexOf('.');
  if (dot === -1) return `$${usd}`;
  const frac = str.slice(dot + 1);

  let zeros = 0;
  while (zeros < frac.length && frac[zeros] === '0') zeros++;

  let sig = frac.slice(zeros, zeros + 3).replace(/0+$/, '');
  if (sig === '') sig = '0';

  const sub = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT_DIGITS[Number(d)] ?? d)
    .join('');
  return `$0.0${sub}${sig}`;
}
