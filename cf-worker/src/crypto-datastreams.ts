// ----------------------------------------------------------------------------
// cf-worker/src/crypto-datastreams.ts
//
// The crypto price swap (Joshua 2026-10-12): a CRYPTO pool settles on the Chainlink Data Streams report for its exact
// close second, verified through Chainlink's verifier on two RPC providers, instead of CoinGecko's live price. Only
// the price source changes; sending stays production's. The full resolver plan (RESOLVER_PRICE_PLAN, feat/ds-resolver)
// replaces the sending side after the hackathon.
//
// Modes (CRYPTO_PRICE_SOURCE): "coingecko" (unset: today's behaviour), "datastreams-shadow" (today's behaviour, plus a
// logged Data Streams decision per pool to compare, nothing sent from it), "datastreams" (crypto pools settle only on
// Data Streams; no CoinGecko, no fallback: a pool without a usable report waits).
// ----------------------------------------------------------------------------

import type { Hex } from 'viem';

import { decodeVerified, fetchReport, verifyOnBoth, type ReportCredentials, type RpcCall } from './datastreams';
import { decideCrypto, feedFor, parseCryptoRef, OUTCOME_YES } from './price-decision';

/// The verification pair Joshua approved on 2026-10-10 (RESOLVER_PRICE_PLAN §4.3): Monad's public RPC and Ankr.
export const VERIFY_RPC_URLS = ['https://testnet-rpc.monad.xyz', 'https://rpc.ankr.com/monad_testnet'] as const;
export const DEFAULT_DATASTREAMS_URL = 'https://api.testnet-dataengine.chain.link';
export const FINALIZED_TIMEOUT_MS = 8_000;
/// Data Streams evaluations per tick, shadow and live alike: each costs one Data Streams request and up to five RPC
/// calls, at most about 32 s with every timeout spent, and the worker runs every minute.
export const DS_PER_TICK = 2;

/// Whether a pool can be evaluated at all: a CRYPTO pool whose ref parses to a coin with a pinned feed. Others get an
/// immediate `wait` with no request, and never use a tick's evaluation slot (adversary r2 on d15c3dc).
export function dsEligible(mType: number, oracleRef: Hex): boolean {
  return feedFor(mType, parseCryptoRef(oracleRef)).ok;
}

/// The pools (by id, eligible ones only, ascending) that get this tick's DS_PER_TICK evaluations. The slots rotate
/// through them by the minute, so with ticks every minute each eligible pool is evaluated at least once every
/// ceil(n / DS_PER_TICK) ticks, and pools that never settle cannot starve later ones (adversary r2 on d15c3dc).
export function dsTurns(eligible: readonly number[], nowMs: number, perTick: number = DS_PER_TICK): Set<number> {
  const n = eligible.length;
  const out = new Set<number>();
  if (n === 0) return out;
  const start = (Math.floor(nowMs / 60_000) * perTick) % n;
  for (let j = 0; j < Math.min(perTick, n); j++) out.add(eligible[(start + j) % n]);
  return out;
}

export type CryptoPriceSource = 'coingecko' | 'datastreams-shadow' | 'datastreams';

/// The configured source; an unknown value keeps today's behaviour and says so.
export function readCryptoPriceSource(raw: string | undefined): { source: CryptoPriceSource; invalid: string | null } {
  const v = raw?.trim() ?? '';
  if (v === '' || v === 'coingecko') return { source: 'coingecko', invalid: null };
  if (v === 'datastreams-shadow' || v === 'datastreams') return { source: v, invalid: null };
  return { source: 'coingecko', invalid: v };
}

export type FinalizedBlock = { number: bigint; timestamp: number };

/// The finalized block from one provider, or null.
export async function readFinalized(fetchImpl: typeof fetch, url: string): Promise<FinalizedBlock | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      signal: AbortSignal.timeout(FINALIZED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { number?: string; timestamp?: string } | null };
    const n = body.result?.number;
    const t = body.result?.timestamp;
    if (typeof n !== 'string' || typeof t !== 'string' || !/^0x[0-9a-f]+$/i.test(n) || !/^0x[0-9a-f]+$/i.test(t)) return null;
    return { number: BigInt(n), timestamp: Number(BigInt(t)) };
  } catch {
    return null;
  }
}

export type DsDecision =
  | { kind: 'settle'; yes: boolean; price: bigint; strike: bigint; symbol: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'final'; reason: string };

export type DsDeps = {
  fetchImpl: typeof fetch;
  base: string;
  creds: ReportCredentials;
  providers: readonly [RpcCall, RpcCall];
  finalized: () => Promise<FinalizedBlock | null>;
  /// The clock read when the request is signed: Data Streams refuses a signature more than 5 s from its own clock, and
  /// a tick reaches its crypto pools well after it starts (adversary on 3da84d8).
  now: () => number;
};

/// The Data Streams decision for one pool, never throwing. `wait` means try again on a later tick; `final` means the
/// verified report for this feed and second is defective and will never settle the pool (a human resolves it).
export async function dataStreamsCryptoDecision(market: { mType: number; oracleRef: Hex; closeTime: number }, deps: DsDeps): Promise<DsDecision> {
  const ref = parseCryptoRef(market.oracleRef);
  const fed = feedFor(market.mType, ref);
  if (!fed.ok || !ref) return { kind: 'wait', reason: fed.ok ? 'parse_fail' : fed.reason };
  const report = await fetchReport({ fetchImpl: deps.fetchImpl, base: deps.base, creds: deps.creds, feedId: fed.feed.feedId, boundary: market.closeTime, nowMs: deps.now() });
  if (!report.ok) return { kind: 'wait', reason: `report_${report.reason}` };
  const block = await deps.finalized();
  if (!block) return { kind: 'wait', reason: 'block_unavailable' };
  const verified = await verifyOnBoth(deps.providers, report.fullReport, block.number);
  if (!verified.ok) return { kind: 'wait', reason: verified.reason };
  const decoded = decodeVerified(verified.verified, 3);
  if (!decoded || decoded.schema !== 3) return { kind: 'final', reason: 'wrong_report' };
  const d = decideCrypto(ref, fed.feed, decoded, market.closeTime, block.timestamp);
  if (d.kind === 'settle') return { kind: 'settle', yes: d.outcome === OUTCOME_YES, price: d.price, strike: d.strike, symbol: ref.symbol };
  return d;
}

/// A price in 18-decimal fixed point as a short decimal string for logs (6 decimals).
export function formatPrice18(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 10n ** 18n;
  const frac = ((a % 10n ** 18n) / 10n ** 12n).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
