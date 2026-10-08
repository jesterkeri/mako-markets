// Market types whose pools cannot be settled on a price today, so new ones are not created (Joshua, 2026-10-08).
// FOREX, COMMODITIES and STOCKS settle on a Pyth Hermes price, which has answered 401 without a paid key since
// 2026-08-26, so such a pool could only ever be refunded. They come back when the Chainlink Data Streams resolver
// (mako-design/RESOLVER_PRICE_PLAN.md) settles them. One list, read by both the Create pool page ("Coming soon") and
// the sponsor's create check (aa-call-allowlist.ts), so removing a type from it reopens both at once.
//
// Values are the MakoMarketsV4 `mType` enum: FOREX = 3, COMMODITIES = 4, STOCKS = 5 (src/lib/contract.ts MarketType).
export const PAUSED_CREATE_MTYPES: ReadonlySet<number> = new Set([3, 4, 5]);
