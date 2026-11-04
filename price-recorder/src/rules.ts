// ----------------------------------------------------------------------------
// price-recorder/src/rules.ts
//
// The constants the candle rules depend on (CHARTS_DS_PLAN 3.3). RULES_REV is bumped by hand whenever any rule in
// 3.1 to 3.3 changes, STALE_EXCLUDE_S included. RULES_VERSION (rules-version.ts, generated) also hashes the resolver's
// decoder file and both feed tables, so a decoder or feed change moves it even if nobody bumps RULES_REV.
// ----------------------------------------------------------------------------

/// Bumped by hand on any change to the rules in plan 3.1 to 3.3.
export const RULES_REV = 'charts-ds-3.3-r1';

/// How raw_fp is built (plan 3.3). Expected never to change.
export const RAW_RULE = 1;

/// A v8 report with market status 2 whose price is older than this (strictly) is stale-excluded: never a price input
/// and never treated as closed (plan 3.3). Calibrated from captured open-market pages before ship (plan 15.6).
export const STALE_EXCLUDE_S = 900;

/// One-minute candles: minute M covers [M, M + 60).
export const MINUTE_S = 60;
