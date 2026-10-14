/**
 * Single source of truth for the FOREX / COMMODITIES / STOCKS asset
 * allowlist that backs the v4 MarketType extensions (mType 3/4/5).
 *
 * Used by:
 *   - `src/lib/aa-call-allowlist.ts` (sponsor-time + send-time +
 *     batched validators all flow through `decodeCreateMarketArgs`,
 *     which gates `oracleRef` against the allowlist for mType ∈ {3,4,5})
 *   - `src/app/create/page.tsx`              (dropdown options on the
 *                                              FOREX / COMMODITIES /
 *                                              STOCKS tabs)
 *   - `cf-worker/src/price-feed-assets.ts`   (byte-identical mirror;
 *                                              see "Mirror" below)
 *   - `watchdog/src/assets.ts`               (symbol -> class table only,
 *                                              MIRROR_PRICE_FEED_ASSETS;
 *                                              the alert-only watchdog
 *                                              Worker, checked by its
 *                                              assets-drift test)
 *
 * Pyth Hermes is the price source (free, no API key, ~30 req/min).
 * IDs below were copied from `GET https://hermes.pyth.network/v2/price_feeds`
 * with asset_type filters (fx, metal, commodities, equity) on
 * 2026-05-22; pinning them here makes the dependency explicit so a
 * future Pyth ID rotation surfaces as a clean reverse-map miss at
 * resolver time rather than silently wrong data.
 *
 * Mirror requirement: `cf-worker/src/price-feed-assets.ts` must be a
 * byte-identical copy. The Worker can't import from `src/lib`. Grep
 * `MIRROR_PRICE_FEED_ASSETS` to find every sync site. The CRYPTO
 * mirror at `cf-worker/src/index.ts:131-150` is the working pattern.
 *
 * Commodity coverage notes:
 * - Natural gas: Pyth has no spot feed, only month-coded futures
 *   (NGDH6 / NGDM6 / etc) with settlement-date semantics we don't
 *   want for binary resolution. Not in the set.
 * - Oil (WTI / BRENT): Pyth's USOILSPOT and UKOILSPOT feeds carry
 *   unusably wide confidence intervals (~80-160bps observed live
 *   2026-05-22) versus the 50bps resolver reject threshold; markets
 *   on those feeds would skip every tick and hit 24h forceRefund.
 *   The aggregate PYTHOIL index feed is tighter (~27bps) but is an
 *   index rather than a true spot price. Both dropped from the set
 *   until a real oil API (Twelve Data, EIA, or similar) is wired in
 *   a follow-up. See [[mako-pyth-feeds]] memory for the decision.
 * - Result: 3 commodities (XAU gold, XAG silver, XPT platinum), all
 *   live with tight confidence (<25bps).
 *
 * Stocks session note: every US equity on Pyth has four feeds:
 * `Equity.US.X/USD` (regular session), `.ON`, `.POST`, `.PRE`
 * (overnight, post-market, pre-market). We use the regular-session
 * feed only. Off-hours session feeds are a future enhancement; the
 * STOCKS tab on /create surfaces a "Off-hours markets settle
 * against last-traded price" caveat for clarity.
 */

export type PriceFeedAssetClass = 'forex' | 'commodities' | 'stocks';

export interface PriceFeedAsset {
  /// Canonical, ALL CAPS, no separator (EURUSD, XAUUSD, AAPL). This
  /// is the on-chain `oracleRef` prefix (`SYMBOL:gt|lt:STRIKE`).
  symbol: string;
  /// Human display ("EUR/USD", "Gold", "Apple"). Used in the /create
  /// dropdown.
  label: string;
  class: PriceFeedAssetClass;
  /// 32-byte Pyth Hermes feed ID in canonical `0x<64 lowercase hex>`
  /// form. Hermes accepts `ids[]=0x...` in requests but returns
  /// `parsed[].id` without the `0x` prefix; the cf-worker fetcher
  /// normalizes incoming response IDs by prepending `0x` before
  /// reverse-map lookup. See `normalizePythId`.
  pythPriceId: `0x${string}`;
  /// Dropdown sort order, lower = first. Roughly: most liquid /
  /// most-traded first within each class.
  priority: number;
  /// Present → render the off-hours warning under the symbol. Only
  /// `us_equity` today (NYSE / NASDAQ); FX runs ~22h/5d which we
  /// treat as effectively always-on, gold/silver run nearly 24/5.
  marketHours?: 'us_equity';
}

export const PRICE_FEED_ASSETS: readonly PriceFeedAsset[] = [
  // ─── FOREX (10 majors) ──────────────────────────────────────────
  // Pyth `asset_type=fx` feeds. All 10 major pairs confirmed
  // present on Hermes. Priority follows global daily volume rank.
  { symbol: 'EURUSD', label: 'EUR/USD', class: 'forex', pythPriceId: '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b', priority: 1 },
  { symbol: 'USDJPY', label: 'USD/JPY', class: 'forex', pythPriceId: '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52', priority: 2 },
  { symbol: 'GBPUSD', label: 'GBP/USD', class: 'forex', pythPriceId: '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1', priority: 3 },
  { symbol: 'AUDUSD', label: 'AUD/USD', class: 'forex', pythPriceId: '0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80', priority: 4 },
  { symbol: 'USDCAD', label: 'USD/CAD', class: 'forex', pythPriceId: '0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca', priority: 5 },
  { symbol: 'USDCHF', label: 'USD/CHF', class: 'forex', pythPriceId: '0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8', priority: 6 },
  { symbol: 'NZDUSD', label: 'NZD/USD', class: 'forex', pythPriceId: '0x92eea8ba1b00078cdc2ef6f64f091f262e8c7d0576ee4677572f314ebfafa4c7', priority: 7 },
  { symbol: 'EURGBP', label: 'EUR/GBP', class: 'forex', pythPriceId: '0xc349ff6087acab1c0c5442a9de0ea804239cc9fd09be8b1a93ffa0ed7f366d9c', priority: 8 },
  { symbol: 'EURJPY', label: 'EUR/JPY', class: 'forex', pythPriceId: '0xd8c874fa511b9838d094109f996890642421e462c3b29501a2560cecf82c2eb4', priority: 9 },
  { symbol: 'GBPJPY', label: 'GBP/JPY', class: 'forex', pythPriceId: '0xcfa65905787703c692c3cac2b8a009a1db51ce68b54f5b206ce6a55bfa2c3cd1', priority: 10 },

  // ─── COMMODITIES (3) ────────────────────────────────────────────
  // Precious metals only. Oil (WTI / BRENT) dropped because the
  // spot feeds on Pyth have ~80-160bps confidence intervals,
  // unusable under the 50bps resolver threshold. Re-add when a
  // dedicated oil API (Twelve Data / EIA / etc) is wired.
  { symbol: 'XAUUSD', label: 'Gold (XAU/USD)',     class: 'commodities', pythPriceId: '0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2', priority: 1 },
  { symbol: 'XAGUSD', label: 'Silver (XAG/USD)',   class: 'commodities', pythPriceId: '0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e', priority: 2 },
  { symbol: 'XPTUSD', label: 'Platinum (XPT/USD)', class: 'commodities', pythPriceId: '0x398e4bbc7cbf89d6648c21e08019d878967677753b3096799595c78f805a34e5', priority: 3 },

  // ─── STOCKS (20 US equities) ────────────────────────────────────
  // All use `Equity.US.X/USD` regular-session feeds. Off-hours
  // (.ON / .POST / .PRE) variants are a future enhancement; the
  // /create page surfaces a caveat string under the STOCKS dropdown.
  { symbol: 'AAPL',  label: 'Apple',              class: 'stocks', pythPriceId: '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688', priority: 1,  marketHours: 'us_equity' },
  { symbol: 'MSFT',  label: 'Microsoft',          class: 'stocks', pythPriceId: '0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1', priority: 2,  marketHours: 'us_equity' },
  { symbol: 'NVDA',  label: 'Nvidia',             class: 'stocks', pythPriceId: '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593', priority: 3,  marketHours: 'us_equity' },
  { symbol: 'GOOGL', label: 'Alphabet (Class A)', class: 'stocks', pythPriceId: '0x5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6', priority: 4,  marketHours: 'us_equity' },
  { symbol: 'AMZN',  label: 'Amazon',             class: 'stocks', pythPriceId: '0xb5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a', priority: 5,  marketHours: 'us_equity' },
  { symbol: 'META',  label: 'Meta Platforms',     class: 'stocks', pythPriceId: '0x78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe', priority: 6,  marketHours: 'us_equity' },
  { symbol: 'TSLA',  label: 'Tesla',              class: 'stocks', pythPriceId: '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1', priority: 7,  marketHours: 'us_equity' },
  { symbol: 'NFLX',  label: 'Netflix',            class: 'stocks', pythPriceId: '0x8376cfd7ca8bcdf372ced05307b24dced1f15b1afafdeff715664598f15a3dd2', priority: 8,  marketHours: 'us_equity' },
  { symbol: 'AMD',   label: 'AMD',                class: 'stocks', pythPriceId: '0x3622e381dbca2efd1859253763b1adc63f7f9abb8e76da1aa8e638a57ccde93e', priority: 9,  marketHours: 'us_equity' },
  { symbol: 'INTC',  label: 'Intel',              class: 'stocks', pythPriceId: '0xc1751e085ee292b8b3b9dd122a135614485a201c35dfc653553f0e28c1baf3ff', priority: 10, marketHours: 'us_equity' },
  { symbol: 'JPM',   label: 'JPMorgan Chase',     class: 'stocks', pythPriceId: '0x7f4f157e57bfcccd934c566df536f34933e74338fe241a5425ce561acdab164e', priority: 11, marketHours: 'us_equity' },
  { symbol: 'BAC',   label: 'Bank of America',    class: 'stocks', pythPriceId: '0x21debc1718a4b76ff74dadf801c261d76c46afaafb74d9645b65e00b80f5ee3e', priority: 12, marketHours: 'us_equity' },
  { symbol: 'V',     label: 'Visa',               class: 'stocks', pythPriceId: '0xc719eb7bab9b2bc060167f1d1680eb34a29c490919072513b545b9785b73ee90', priority: 13, marketHours: 'us_equity' },
  { symbol: 'MA',    label: 'Mastercard',         class: 'stocks', pythPriceId: '0x639db3fe6951d2465bd722768242e68eb0285f279cb4fa97f677ee8f80f1f1c0', priority: 14, marketHours: 'us_equity' },
  { symbol: 'WMT',   label: 'Walmart',            class: 'stocks', pythPriceId: '0x327ae981719058e6fb44e132fb4adbf1bd5978b43db0661bfdaefd9bea0c82dc', priority: 15, marketHours: 'us_equity' },
  { symbol: 'DIS',   label: 'Disney',             class: 'stocks', pythPriceId: '0x703e36203020ae6761e6298975764e266fb869210db9b35dd4e4225fa68217d0', priority: 16, marketHours: 'us_equity' },
  { symbol: 'KO',    label: 'Coca-Cola',          class: 'stocks', pythPriceId: '0x9aa471dccea36b90703325225ac76189baf7e0cc286b8843de1de4f31f9caa7d', priority: 17, marketHours: 'us_equity' },
  { symbol: 'PEP',   label: 'PepsiCo',            class: 'stocks', pythPriceId: '0xbe230eddb16aad5ad273a85e581e74eb615ebf67d378f885768d9b047df0c843', priority: 18, marketHours: 'us_equity' },
  { symbol: 'BA',    label: 'Boeing',             class: 'stocks', pythPriceId: '0x8419416ba640c8bbbcf2d464561ed7dd860db1e38e51cec9baf1e34c4be839ae', priority: 19, marketHours: 'us_equity' },
  { symbol: 'GS',    label: 'Goldman Sachs',      class: 'stocks', pythPriceId: '0x9c68c0c6999765cf6e27adf75ed551b34403126d3b0d5b686a2addb147ed4554', priority: 20, marketHours: 'us_equity' },
] as const;

// ─── Module-load assertions ─────────────────────────────────────────
// Throw at boot if a pinned ID is malformed. Catches typos at
// deploy time rather than silently miss in production. Tests assert
// the assertions actually fire.

/// Normalize a Pyth feed ID to canonical `0x<64 lowercase hex>`.
/// Accepts `0x<hex>` OR bare `<hex>`. Throws on anything else.
/// Used at module load over every pinned ID AND by the cf-worker
/// fetcher to normalize Hermes response `parsed[].id` (which is
/// bare hex per Pyth v2 API docs) before reverse-map lookup.
export function normalizePythId(s: string): `0x${string}` {
  if (typeof s !== 'string' || s.length === 0) {
    throw new TypeError('normalizePythId: empty / non-string');
  }
  const lower = s.toLowerCase();
  const body = lower.startsWith('0x') ? lower.slice(2) : lower;
  if (body.length !== 64) {
    throw new TypeError(
      `normalizePythId: expected 64 hex chars (with or without 0x prefix); got ${body.length} from input length ${s.length}`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new TypeError('normalizePythId: contains non-hex characters');
  }
  return `0x${body}` as `0x${string}`;
}

// Run the normalizer over every pinned ID at import time; a typo
// throws here instead of producing a silent reverse-map miss in
// production. The result also seeds the reverse map below.
const NORMALIZED_IDS = PRICE_FEED_ASSETS.map((a) => ({
  symbol: a.symbol,
  pythPriceId: normalizePythId(a.pythPriceId),
}));

// ─── Lookup structures ──────────────────────────────────────────────

export const PRICE_FEED_SYMBOLS: ReadonlySet<string> = new Set(
  PRICE_FEED_ASSETS.map((a) => a.symbol),
);

export const PRICE_FEED_BY_SYMBOL: ReadonlyMap<string, PriceFeedAsset> =
  new Map(PRICE_FEED_ASSETS.map((a) => [a.symbol, a]));

/// Canonical-0x-form Pyth ID → symbol. Resolver does
/// `PYTH_ID_TO_SYMBOL.get(normalizePythId(parsed.id))` to map a
/// Hermes response row back to its symbol.
export const PYTH_ID_TO_SYMBOL: ReadonlyMap<`0x${string}`, string> = new Map(
  NORMALIZED_IDS.map((n) => [n.pythPriceId, n.symbol]),
);

// ─── Helpers ────────────────────────────────────────────────────────

export function getAssetsByClass(
  c: PriceFeedAssetClass,
): readonly PriceFeedAsset[] {
  return PRICE_FEED_ASSETS.filter((a) => a.class === c).sort(
    (a, b) => a.priority - b.priority,
  );
}

export function isPriceFeedSymbol(s: string): boolean {
  // Case-sensitive: the allowlist is canonical ALL CAPS. A lowercase
  // submission must NOT match — that's a malformed oracleRef.
  return PRICE_FEED_SYMBOLS.has(s);
}

/// Returns the raw price-id array for batched Hermes fetches. The
/// caller builds the query string using repeated `ids[]=<id>` params
/// per the Hermes v2 spec; Hermes does NOT accept a comma-separated
/// value, so do not naively .join(',').
export function getPythPriceIds(): readonly `0x${string}`[] {
  return NORMALIZED_IDS.map((n) => n.pythPriceId);
}
