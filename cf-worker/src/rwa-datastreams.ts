// ----------------------------------------------------------------------------
// cf-worker/src/rwa-datastreams.ts
//
// The forex / metals / stocks price swap (Joshua 2026-10-15): a FOREX, COMMODITIES or STOCKS pool settles on the
// Chainlink Data Streams v8 report for its exact close second, verified through Chainlink's verifier on the same two
// providers as crypto (src/crypto-datastreams.ts), instead of Pyth Hermes, which has answered 401 without a paid key
// since 2026-08-26 (so these classes have been paused for creation since 2026-10-08). Only the price source changes;
// sending stays production's.
//
// Modes (RWA_PRICE_SOURCE): "pyth" (unset: today's behaviour), "datastreams-shadow" (today's behaviour plus a logged
// Data Streams decision per pool, nothing sent from it), "datastreams" (these pools settle only on Data Streams; no
// Pyth, no fallback: a pool without a usable report waits).
// ----------------------------------------------------------------------------

import { keccak256, type Hex } from 'viem';

import type { DsDeps } from './crypto-datastreams';
import { decodeVerified, fetchReport, verifyOnBoth } from './datastreams';
import { OUTCOME_YES } from './price-decision';
import { decideRwa, parseRwaRef, rwaFeedFor } from './rwa-decision';

export type RwaPriceSource = 'pyth' | 'datastreams-shadow' | 'datastreams';

/// The configured source; an unknown value keeps today's behaviour and says so.
export function readRwaPriceSource(raw: string | undefined): { source: RwaPriceSource; invalid: string | null } {
  const v = raw?.trim() ?? '';
  if (v === '' || v === 'pyth') return { source: 'pyth', invalid: null };
  if (v === 'datastreams-shadow' || v === 'datastreams') return { source: v, invalid: null };
  return { source: 'pyth', invalid: v };
}

/// Whether a pool can be evaluated at all: a FOREX / COMMODITIES / STOCKS pool whose ref parses to a symbol of its own
/// class with a pinned v8 feed. Others wait with no request and never take a tick's Data Streams slot.
export function rwaDsEligible(mType: number, oracleRef: Hex): boolean {
  return rwaFeedFor(mType, parseRwaRef(oracleRef)).ok;
}

/// What a settle decision rests on, all strings so a log line can never hold a bigint.
export type RwaEvidence = {
  feedId: string;
  observationsTimestamp: string;
  validFromTimestamp: string;
  expiresAt: string;
  midPrice: string;
  marketStatus: string;
  lastUpdateTimestampNs: string;
  lastUpdateAgeS: string;
  fullReportKeccak: string;
  verifiedKeccak: string;
  verifyBlock: string;
  verifyBlockTime: string;
  verifiedBy: readonly string[];
};

export type RwaDsDecision =
  | { kind: 'settle'; yes: boolean; price: bigint; strike: bigint; symbol: string; marketClosed: boolean; evidence: RwaEvidence }
  | { kind: 'wait'; reason: string }
  | { kind: 'final'; reason: string };

/// The Data Streams decision for one pool, never throwing. `wait` means try again on a later tick; `final` means the
/// verified report for this feed and second is defective and will never settle the pool (a human resolves it).
export async function dataStreamsRwaDecision(market: { mType: number; oracleRef: Hex; closeTime: number }, deps: DsDeps): Promise<RwaDsDecision> {
  const ref = parseRwaRef(market.oracleRef);
  const fed = rwaFeedFor(market.mType, ref);
  if (!fed.ok || !ref) return { kind: 'wait', reason: fed.ok ? 'parse_fail' : fed.reason };
  const report = await fetchReport({ fetchImpl: deps.fetchImpl, base: deps.base, creds: deps.creds, feedId: fed.feed.feedId, boundary: market.closeTime, nowMs: deps.now() });
  if (!report.ok) return { kind: 'wait', reason: `report_${report.reason}` };
  const fin = await deps.finalized();
  if (!fin.ok) return { kind: 'wait', reason: fin.reason };
  const block = fin.block;
  const verified = await verifyOnBoth(deps.providers, report.fullReport, block.number);
  if (!verified.ok) return { kind: 'wait', reason: verified.reason };
  const decoded = decodeVerified(verified.verified, 8);
  if (!decoded || decoded.schema !== 8) return { kind: 'final', reason: 'wrong_report' };
  // Expiry judged at the LATER of the agreed block's time and the worker's own clock, as for crypto (adversary on
  // 2c716f6): an old agreed block can never make an expired report look unexpired.
  const expiryAt = Math.max(block.timestamp, Math.floor(deps.now() / 1000));
  const d = decideRwa(ref, fed.feed, decoded, market.closeTime, expiryAt);
  if (d.kind !== 'settle') return d;
  const evidence: RwaEvidence = {
    feedId: decoded.feedId,
    observationsTimestamp: String(decoded.observationsTimestamp),
    validFromTimestamp: String(decoded.validFromTimestamp),
    expiresAt: String(decoded.expiresAt),
    midPrice: decoded.midPrice.toString(),
    marketStatus: String(decoded.marketStatus),
    lastUpdateTimestampNs: decoded.lastUpdateTimestamp.toString(),
    lastUpdateAgeS: d.lastUpdateAgeS.toFixed(3),
    fullReportKeccak: keccak256(report.fullReport),
    verifiedKeccak: keccak256(verified.verified),
    verifyBlock: block.number.toString(),
    verifyBlockTime: String(block.timestamp),
    // verifyOnBoth returns ok only when both providers answered with identical verified bytes.
    verifiedBy: deps.verifiedBy,
  };
  return { kind: 'settle', yes: d.outcome === OUTCOME_YES, price: d.price, strike: d.strike, symbol: ref.symbol, marketClosed: d.marketStatus === 1, evidence };
}
