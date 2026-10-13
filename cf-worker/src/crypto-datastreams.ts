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

import { keccak256, type Hex } from 'viem';

import { decodeVerified, fetchReport, verifyOnBoth, type ReportCredentials, type RpcCall } from './datastreams';
import { decideCrypto, feedFor, parseCryptoRef, OUTCOME_YES } from './price-decision';

export const ANKR_RPC_URL = 'https://rpc.ankr.com/monad_testnet';
/// The only host ALCHEMY_RPC_URL may name: Alchemy's Monad testnet endpoint.
export const ALCHEMY_MONAD_HOST = 'monad-testnet.g.alchemy.com';

/// The verification pair (Joshua 2026-10-13): Alchemy + Ankr. The public Monad RPC (the 2026-10-10 pair with Ankr) kept
/// failing from Cloudflare on 2026-10-13, and a failing provider makes every crypto pool wait. Alchemy's URL carries
/// its key: it is the worker secret ALCHEMY_RPC_URL, never logged (only hostnames reach the evidence). An ALLOWLIST:
/// null unless the URL is https on exactly Alchemy's Monad host (a trailing DNS-root dot is ignored), so a wrong secret
/// can never make Ankr, the public RPC or an unknown host the second verifier (adversary on 6875a42).
export function verifyPair(alchemyUrl: string | undefined): readonly [string, string] | null {
  const u = alchemyUrl?.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
    if (parsed.hostname.replace(/\.$/, '') !== ALCHEMY_MONAD_HOST) return null;
  } catch {
    return null;
  }
  return [u, ANKR_RPC_URL];
}
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

/// The pools (by id, eligible ones only, ascending) that get this tick's DS_PER_TICK Data Streams evaluations. The
/// slots rotate through them by the minute, so crypto pools that never settle cannot keep the Data Streams slots from
/// later crypto pools (adversary r2 on d15c3dc); when n shrinks the phase restarts (adversary r3).
///
/// This bounds nothing about settlement time. Sending is production's unchanged rule: at most one transaction per tick,
/// markets in id order, any type; a pool reached after the tick's send is deferred before its evaluation and loses that
/// minute's turn. So, exactly as for every pool type today, a steady run of lower-id pools settling each minute can
/// delay a crypto pool indefinitely (Codex DS_SWAP R1). A fair send slot is the full resolver plan's job
/// (RESOLVER_PRICE_PLAN §4.9), after this stopgap.
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
type BlockHeader = FinalizedBlock & { hash: string };

/// A finalized block may be at most this old on the worker's own clock (Monad finalizes in about a second), and at most
/// this far in the future. A stale block could make an expired report look unexpired (Codex DS_SWAP R4).
export const MAX_FINALIZED_AGE_S = 60;
export const MAX_FINALIZED_AHEAD_S = 10;

/// One block header from one provider: `tag` is "finalized" or a 0x block number. Null on any failure.
export async function readBlock(fetchImpl: typeof fetch, url: string, tag: string): Promise<BlockHeader | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [tag, false] }),
      signal: AbortSignal.timeout(FINALIZED_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { number?: string; timestamp?: string; hash?: string } | null };
    const n = body.result?.number;
    const t = body.result?.timestamp;
    const h = body.result?.hash;
    if (typeof n !== 'string' || typeof t !== 'string' || !/^0x[0-9a-f]+$/i.test(n) || !/^0x[0-9a-f]+$/i.test(t)) return null;
    if (typeof h !== 'string' || !/^0x[0-9a-f]{64}$/i.test(h)) return null;
    return { number: BigInt(n), timestamp: Number(BigInt(t)), hash: h.toLowerCase() };
  } catch {
    return null;
  }
}

export type FinalizedResult = { ok: true; block: FinalizedBlock } | { ok: false; reason: 'block_unavailable' | 'block_disagree' | 'block_stale' };

/// The verification block, agreed by BOTH providers (Codex DS_SWAP R4): each names its finalized block, the lower one
/// is taken, and both must return the same hash and timestamp for it; it must also be fresh on the worker's clock. So
/// neither provider alone can choose the block whose timestamp the expiry check uses, and a stale pair waits.
export async function agreedFinalized(fetchImpl: typeof fetch, urls: readonly [string, string], nowMs: number): Promise<FinalizedResult> {
  const [a, b] = await Promise.all(urls.map((u) => readBlock(fetchImpl, u, 'finalized')));
  if (!a || !b) return { ok: false, reason: 'block_unavailable' };
  const n = a.number < b.number ? a.number : b.number;
  const tag = `0x${n.toString(16)}`;
  const [x, y] = await Promise.all([a.number === n ? a : readBlock(fetchImpl, urls[0], tag), b.number === n ? b : readBlock(fetchImpl, urls[1], tag)]);
  if (!x || !y) return { ok: false, reason: 'block_unavailable' };
  if (x.number !== n || y.number !== n || x.hash !== y.hash || x.timestamp !== y.timestamp) return { ok: false, reason: 'block_disagree' };
  const nowS = Math.floor(nowMs / 1000);
  if (x.timestamp < nowS - MAX_FINALIZED_AGE_S || x.timestamp > nowS + MAX_FINALIZED_AHEAD_S) return { ok: false, reason: 'block_stale' };
  return { ok: true, block: { number: n, timestamp: x.timestamp } };
}

/// What a settle decision rests on, all strings so a log line can never hold a bigint (the shadow crash, 2026-10-13).
export type DsEvidence = {
  feedId: string;
  observationsTimestamp: string;
  validFromTimestamp: string;
  expiresAt: string;
  price: string;
  bid: string;
  ask: string;
  fullReportKeccak: string;
  verifiedKeccak: string;
  verifyBlock: string;
  verifyBlockTime: string;
  verifiedBy: readonly string[];
};

export type DsDecision =
  | { kind: 'settle'; yes: boolean; price: bigint; strike: bigint; symbol: string; evidence: DsEvidence }
  | { kind: 'wait'; reason: string }
  | { kind: 'final'; reason: string };

export type DsDeps = {
  fetchImpl: typeof fetch;
  base: string;
  creds: ReportCredentials;
  providers: readonly [RpcCall, RpcCall];
  /// The block both providers agree is finalized and fresh (agreedFinalized), or why not.
  finalized: () => Promise<FinalizedResult>;
  /// The providers' hostnames, for the evidence (never the URLs: Alchemy's carries a key).
  verifiedBy: readonly string[];
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
  const fin = await deps.finalized();
  if (!fin.ok) return { kind: 'wait', reason: fin.reason };
  const block = fin.block;
  const verified = await verifyOnBoth(deps.providers, report.fullReport, block.number);
  if (!verified.ok) return { kind: 'wait', reason: verified.reason };
  const decoded = decodeVerified(verified.verified, 3);
  if (!decoded || decoded.schema !== 3) return { kind: 'final', reason: 'wrong_report' };
  const d = decideCrypto(ref, fed.feed, decoded, market.closeTime, block.timestamp);
  if (d.kind === 'settle') {
    const evidence: DsEvidence = {
      feedId: decoded.feedId,
      observationsTimestamp: String(decoded.observationsTimestamp),
      validFromTimestamp: String(decoded.validFromTimestamp),
      expiresAt: String(decoded.expiresAt),
      price: decoded.price.toString(),
      bid: decoded.bid.toString(),
      ask: decoded.ask.toString(),
      fullReportKeccak: keccak256(report.fullReport),
      verifiedKeccak: keccak256(verified.verified),
      verifyBlock: block.number.toString(),
      verifyBlockTime: String(block.timestamp),
      // verifyOnBoth returns ok only when both providers answered with identical verified bytes.
      verifiedBy: deps.verifiedBy,
    };
    return { kind: 'settle', yes: d.outcome === OUTCOME_YES, price: d.price, strike: d.strike, symbol: ref.symbol, evidence };
  }
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
