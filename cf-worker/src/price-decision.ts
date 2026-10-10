// ----------------------------------------------------------------------------
// cf-worker/src/price-decision.ts
//
// The settlement rule for a CRYPTO pool on a verified Data Streams v3 report (RESOLVER_PRICE_PLAN r15 §3 steps 1, 4,
// 5, 7). Pure: the same inputs give the same answer, and nothing here fetches, signs or stores.
//   * eligibility: the pool's symbol has a pinned v3 settlement feed (src/crypto-feeds.json);
//   * the strike: parsed from the oracle ref as a decimal string into an integer at 10^18, never through a float;
//   * the report (decoded only from the verifier's bytes): pinned feed, observed at exactly the close second C,
//     validFrom <= observed, unexpired at the block time T, price > 0, bid <= price <= ask, spread within 50 bps;
//   * the outcome: gt -> YES iff price > strike; lt -> YES iff price < strike; equality -> NO for both.
// ----------------------------------------------------------------------------

import type { Hex } from 'viem';

import feedTable from './crypto-feeds.json';
import type { V3Report } from './datastreams';

export const PRICE_DECIMALS = 18;
export const MAX_SPREAD_BPS = 50n;
/// MarketType.CRYPTO in MakoMarketsV4.sol (market #105, "SUI:gt:1.2", reads mType 1 on chain).
export const MARKET_TYPE_CRYPTO = 1;
/// Outcome.YES / Outcome.NO in MakoMarketsV4.sol.
export const OUTCOME_YES = 1;
export const OUTCOME_NO = 2;

export type CryptoFeed = { symbol: string; feedId: Hex; schema: 3 };
export const CRYPTO_FEEDS: ReadonlyMap<string, CryptoFeed> = new Map(
  (feedTable.feeds as { symbol: string; feedId: string; schema: number }[]).map((f) => {
    if (f.schema !== 3 || !/^0x0003[0-9a-f]{60}$/.test(f.feedId)) throw new Error(`crypto-feeds.json: bad entry ${f.symbol}`);
    return [f.symbol, { symbol: f.symbol, feedId: f.feedId as Hex, schema: 3 }];
  }),
);

export type CryptoRef = { symbol: string; op: 'gt' | 'lt'; strike: bigint };

/// `SYMBOL:gt|lt:STRIKE` from the market's bytes32 oracle ref (NUL-padded ASCII). The strike is a plain positive
/// decimal with at most 18 places, parsed exactly. Anything else is null (`parse_fail`).
export function parseCryptoRef(oracleRef: Hex): CryptoRef | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(oracleRef)) return null;
  const bytes = oracleRef.slice(2).match(/../g)!.map((b) => parseInt(b, 16));
  const end = bytes.indexOf(0);
  const used = end === -1 ? bytes : bytes.slice(0, end);
  if (end !== -1 && bytes.slice(end).some((b) => b !== 0)) return null;
  if (used.some((b) => b < 0x20 || b > 0x7e)) return null;
  const text = String.fromCharCode(...used);
  const m = /^([A-Z0-9]{2,10}):(gt|lt):(\d{1,30})(?:\.(\d{1,18}))?$/.exec(text);
  if (!m) return null;
  const [, symbol, op, whole, frac = ''] = m;
  const strike = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
  if (strike <= 0n) return null;
  return { symbol, op: op as 'gt' | 'lt', strike };
}

export type FinalReason = 'wrong_report';
export type RetryReason = 'symbol_paused' | 'parse_fail' | 'bad_spread' | 'report_expired' | 'report_mismatch';
export type Decision =
  | { kind: 'settle'; outcome: typeof OUTCOME_YES | typeof OUTCOME_NO; price: bigint; strike: bigint; reason: 'ok' }
  | { kind: 'final'; reason: FinalReason }
  | { kind: 'wait'; reason: RetryReason };

/// The pool's feed, or why it has none. Eligible only as a CRYPTO-type market whose symbol has a pinned v3 feed: V4 does
/// not check an oracle ref against the market type, so a direct-created STOCKS market reading `BTC:gt:60000` must not
/// settle on BTC (adversary on plan r17, finding 3).
export function feedFor(mType: number, ref: CryptoRef | null): { ok: true; feed: CryptoFeed } | { ok: false; reason: 'parse_fail' | 'symbol_paused' | 'class_paused' } {
  if (mType !== MARKET_TYPE_CRYPTO) return { ok: false, reason: 'class_paused' };
  if (!ref) return { ok: false, reason: 'parse_fail' };
  const feed = CRYPTO_FEEDS.get(ref.symbol);
  return feed ? { ok: true, feed } : { ok: false, reason: 'symbol_paused' };
}

/// Decides a pool with close second `closeSecond` from its verified, decoded report, judged at block time `blockTime`.
export function decideCrypto(ref: CryptoRef, feed: CryptoFeed, report: V3Report, closeSecond: number, blockTime: number): Decision {
  // A verified report for another feed or another second is not this pool's report, but the API is untrusted for
  // availability: a retry can return the right one, so this waits (plan r21; adversary on r20, finding 3).
  if (report.feedId !== feed.feedId.toLowerCase()) return { kind: 'wait', reason: 'report_mismatch' };
  if (report.observationsTimestamp !== closeSecond) return { kind: 'wait', reason: 'report_mismatch' };
  // An intrinsic defect of the report for this feed and second can never become right: final.
  if (report.validFromTimestamp > report.observationsTimestamp) return { kind: 'final', reason: 'wrong_report' };
  if (report.price <= 0n) return { kind: 'final', reason: 'wrong_report' };
  if (!(report.expiresAt > blockTime)) return { kind: 'wait', reason: 'report_expired' };
  if (report.bid > report.price || report.price > report.ask) return { kind: 'wait', reason: 'bad_spread' };
  // In uint256 terms: (ask - bid) * 10000 <= price * 50, with bid <= ask already established.
  if ((report.ask - report.bid) * 10_000n > report.price * MAX_SPREAD_BPS) return { kind: 'wait', reason: 'bad_spread' };
  const yes = ref.op === 'gt' ? report.price > ref.strike : report.price < ref.strike;
  return { kind: 'settle', outcome: yes ? OUTCOME_YES : OUTCOME_NO, price: report.price, strike: ref.strike, reason: 'ok' };
}
