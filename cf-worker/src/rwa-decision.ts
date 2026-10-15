// ----------------------------------------------------------------------------
// cf-worker/src/rwa-decision.ts
//
// The settlement rule for a FOREX, COMMODITIES or STOCKS pool on a verified Data Streams v8 report (Joshua
// 2026-10-15: "handle the data streams"; the same price swap as crypto, src/price-decision.ts). Pure: the same inputs
// give the same answer, and nothing here fetches, signs or stores.
//   * eligibility: the pool's market type matches its symbol's class and the symbol has a pinned v8 feed
//     (src/rwa-feeds.json, the 24 verified feeds; the other 9 app symbols have no usable feed and stay paused);
//   * the strike: parsed from the oracle ref into an integer at 10^18, never through a float, accepting exactly the
//     forms the sponsor's create check accepts (`+?(\d+\.\d+|\d+|\.\d+)`);
//   * the report (decoded only from the verifier's bytes): pinned feed, observed at exactly the close second C,
//     validFrom <= observed, a last-update time that is not zero and not after C, midPrice > 0, unexpired;
//   * market status (Chainlink v8: 0 unknown, 1 closed, 2 open): open settles on the mid price for C; closed settles
//     on the same signed price, which is the last traded one (disclosed on the create page); unknown waits;
//   * the outcome: gt -> YES iff midPrice > strike; lt -> YES iff midPrice < strike; equality -> NO for both.
// ----------------------------------------------------------------------------

import { hexToString, type Hex } from 'viem';

import type { V8Report } from './datastreams';
import { OUTCOME_NO, OUTCOME_YES } from './price-decision';
import feedTable from './rwa-feeds.json';

/// MarketType in MakoMarketsV4.sol: FOREX = 3, COMMODITIES = 4, STOCKS = 5.
export const RWA_MARKET_TYPES: Readonly<Record<number, RwaClass>> = { 3: 'forex', 4: 'commodities', 5: 'stocks' };
export type RwaClass = 'forex' | 'commodities' | 'stocks';

/// Chainlink v8 marketStatus (docs.chain.link/data-streams/reference/report-schema-v8).
export const MARKET_STATUS_CLOSED = 1;
export const MARKET_STATUS_OPEN = 2;

export type RwaFeed = { symbol: string; class: RwaClass; feedId: Hex; schema: 8 };
export const RWA_FEEDS: ReadonlyMap<string, RwaFeed> = new Map(
  (feedTable.feeds as { symbol: string; class: string; feedId: string; schema: number }[]).map((f) => {
    if (f.schema !== 8 || !/^0x0008[0-9a-f]{60}$/.test(f.feedId) || !['forex', 'commodities', 'stocks'].includes(f.class)) {
      throw new Error(`rwa-feeds.json: bad entry ${f.symbol}`);
    }
    return [f.symbol, { symbol: f.symbol, class: f.class as RwaClass, feedId: f.feedId as Hex, schema: 8 }];
  }),
);

export type RwaRef = { symbol: string; op: 'gt' | 'lt'; strike: bigint };

/// `SYMBOL:gt|lt:STRIKE` from the market's bytes32 oracle ref, normalised EXACTLY as the sponsor's create check
/// (src/lib/aa-call-allowlist.ts parsePriceFeedOracleRef) and the old Pyth path (index.ts decodeOracleRefString) do:
/// UTF-8 decode, trailing NULs stripped, whitespace trimmed, each part trimmed. So every ref the sponsor accepts, this
/// reads (adversary on 67a1cbe: a tab or trailing space passed the sponsor and failed a stricter parser here, so the
/// pool could never settle). The strike is parsed exactly at 10^18; more than 18 decimal places, or anything else,
/// is null (`parse_fail`).
export function parseRwaRef(oracleRef: Hex): RwaRef | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(oracleRef)) return null;
  let decoded: string;
  try {
    decoded = hexToString(oracleRef, { size: 32 }).replace(/\0+$/, '').trim();
  } catch {
    return null;
  }
  if (decoded.length === 0) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [symbol, op, strikeText] = parts;
  if (op !== 'gt' && op !== 'lt') return null;
  const m = /^\+?(?:(\d+)\.(\d{1,18})|(\d+)|\.(\d{1,18}))$/.exec(strikeText);
  if (!m) return null;
  const whole = m[1] ?? m[3] ?? '0';
  const frac = m[2] ?? m[4] ?? '';
  if (whole.length > 30) return null;
  const strike = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
  if (strike <= 0n) return null;
  return { symbol, op, strike };
}

/// The pool's feed, or why it has none. The market type must match the symbol's class: V4 does not check an oracle ref
/// against the market type, so a direct-created FOREX market reading `AAPL:gt:200` must not settle on AAPL.
export function rwaFeedFor(mType: number, ref: RwaRef | null): { ok: true; feed: RwaFeed } | { ok: false; reason: 'parse_fail' | 'symbol_paused' | 'class_paused' | 'class_mismatch' } {
  const cls = RWA_MARKET_TYPES[mType];
  if (!cls) return { ok: false, reason: 'class_paused' };
  if (!ref) return { ok: false, reason: 'parse_fail' };
  const feed = RWA_FEEDS.get(ref.symbol);
  if (!feed) return { ok: false, reason: 'symbol_paused' };
  if (feed.class !== cls) return { ok: false, reason: 'class_mismatch' };
  return { ok: true, feed };
}

export type RwaDecision =
  | { kind: 'settle'; outcome: typeof OUTCOME_YES | typeof OUTCOME_NO; price: bigint; strike: bigint; marketStatus: 1 | 2; lastUpdateAgeS: number; reason: 'ok' }
  | { kind: 'final'; reason: 'wrong_report' }
  | { kind: 'wait'; reason: 'report_mismatch' | 'report_expired' | 'market_status_unknown' };

/// Decides a pool with close second `closeSecond` from its verified, decoded v8 report, judged at time `blockTime`.
export function decideRwa(ref: RwaRef, feed: RwaFeed, report: V8Report, closeSecond: number, blockTime: number): RwaDecision {
  // Another feed's or another second's report is not this pool's; the API is untrusted for availability, so wait.
  if (report.feedId !== feed.feedId.toLowerCase()) return { kind: 'wait', reason: 'report_mismatch' };
  if (report.observationsTimestamp !== closeSecond) return { kind: 'wait', reason: 'report_mismatch' };
  // Intrinsic defects of the report for this feed and second never become right: final (a human resolves it).
  if (report.validFromTimestamp > report.observationsTimestamp) return { kind: 'final', reason: 'wrong_report' };
  if (report.midPrice <= 0n) return { kind: 'final', reason: 'wrong_report' };
  // lastUpdateTimestamp is in nanoseconds; zero, or a last update after the close second, is structurally inconsistent.
  if (report.lastUpdateTimestamp <= 0n || report.lastUpdateTimestamp >= BigInt(closeSecond + 1) * 1_000_000_000n) {
    return { kind: 'final', reason: 'wrong_report' };
  }
  if (!(report.expiresAt > blockTime)) return { kind: 'wait', reason: 'report_expired' };
  const status = report.marketStatus;
  if (status !== MARKET_STATUS_OPEN && status !== MARKET_STATUS_CLOSED) return { kind: 'wait', reason: 'market_status_unknown' };
  const lastUpdateAgeS = Number(BigInt(closeSecond) * 1_000_000_000n - report.lastUpdateTimestamp) / 1e9;
  const yes = ref.op === 'gt' ? report.midPrice > ref.strike : report.midPrice < ref.strike;
  return { kind: 'settle', outcome: yes ? OUTCOME_YES : OUTCOME_NO, price: report.midPrice, strike: ref.strike, marketStatus: status, lastUpdateAgeS, reason: 'ok' };
}
