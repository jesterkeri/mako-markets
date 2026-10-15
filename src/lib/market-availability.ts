// What a new pool may not be created on, because the resolver could never settle it on a price.
//
// FOREX, COMMODITIES and STOCKS were paused as whole types from 2026-10-08 (Pyth Hermes answers 401 without a paid key
// since 2026-08-26). Since 2026-10-15 they settle on Chainlink Data Streams v8 reports (cf-worker/src/rwa-decision.ts),
// so the types are open again, except the 9 symbols with no usable v8 feed (mako-design/bench/datastreams-probe/
// mako-feed-map.json, status "paused"). One list each, read by both the Create pool page and the sponsor's create
// check (aa-call-allowlist.ts), so a change here applies to both at once.
//
// Values are the MakoMarketsV4 `mType` enum (src/lib/contract.ts MarketType).
export const PAUSED_CREATE_MTYPES: ReadonlySet<number> = new Set<number>();

/// Price-feed symbols (FOREX / COMMODITIES / STOCKS) without a usable Chainlink Data Streams feed: shown as not
/// available on the Create pool page and refused by the sponsor. Must match the resolver's absence from
/// cf-worker/src/rwa-feeds.json (tests check both sides).
export const PAUSED_PRICE_FEED_SYMBOLS: ReadonlySet<string> = new Set(['EURGBP', 'EURJPY', 'GBPJPY', 'AMD', 'DIS', 'KO', 'PEP', 'BA', 'GS']);
