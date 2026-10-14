// rounds-delivery: the one delivery module both settlement paths run (SPEC §5.5, INVARIANTS N15).
//
// Pure. No fetch, no clock, no crypto of its own, no logging. The caller does the I/O and injects the HMAC,
// so the Cloudflare keeper and, later, the CRE workflow submit byte-identical calldata from the same code.
//
// What a submission is (SPEC §5.1): two Data Streams full reports, exactly as the REST API returns them, for
// B = startTime and B = closeTime. It never carries a price or an outcome; the contract verifies both
// reports through Chainlink's verifier and derives everything.

import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';
import { ROUNDS_ABI } from './abi';

export { ROUNDS_ABI };

/// BTC/USD on the Data Streams testnet, SPEC §4. The contract pins the same id; a report for any other feed
/// is refused on-chain, and refused here first so it never costs gas.
export const FEED_ID = '0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439' as const;

/// SPEC §5.5 step 5: the keeper waits this long past closeTime, so CRE settles first when it is healthy.
export const KEEPER_DELAY_S = 300;

/// SPEC §5.5a / T0.1c: `settle` must stay at or under 1,000,000 gas.
export const SETTLE_GAS_CEILING = 1_000_000n;

/// sha256 of the empty body, hex: the third field of Chainlink's HMAC string for a GET.
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------------------------------------
// Reading the contract
// ---------------------------------------------------------------------------------------------------------

export const pendingSettlementData = (): Hex => encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'pendingSettlement' });
export const durationData = (): Hex => encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'DURATION' });
export const closeTimeData = (roundId: bigint): Hex =>
  encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', args: [roundId] });

export const decodePending = (data: Hex): readonly bigint[] =>
  decodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'pendingSettlement', data });
export const decodeDuration = (data: Hex): bigint =>
  BigInt(decodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'DURATION', data }));
export const decodeCloseTime = (data: Hex): bigint =>
  BigInt(decodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', args: [0n], data }));

export interface Due {
  roundId: bigint;
  /// The two boundary seconds whose reports settle it: B = startTime and B = closeTime.
  anchorAt: number;
  closeAt: number;
}

/// The round to settle this run, or null. Of the rounds `pendingSettlement()` returned that are at least
/// `delayS` past close and not in `skip`, the one tried LEAST RECENTLY (never tried first), then the earliest
/// close, then the lower id. Taking turns matters: a round that cannot settle (its report is missing, its
/// spread is too wide) must only spend its own turn, never block every later round until its deadline,
/// where the later rounds would refund NoPrice despite valid reports (adversary pass, 2026-09-28).
/// One per run: the keeper never has more than one transaction in flight (T0.1c).
export function pickRound(
  pending: readonly bigint[],
  closeTimes: ReadonlyMap<bigint, bigint>,
  duration: bigint,
  nowS: number,
  delayS: number = KEEPER_DELAY_S,
  lastTried: ReadonlyMap<bigint, number> = new Map(),
  skip: ReadonlySet<bigint> = new Set(),
): Due | null {
  let best: { id: bigint; close: bigint; tried: number } | null = null;
  for (const id of pending) {
    if (skip.has(id)) continue;
    const close = closeTimes.get(id);
    if (close === undefined) continue;
    if (BigInt(nowS) < close + BigInt(delayS)) continue;
    const tried = lastTried.get(id) ?? Number.NEGATIVE_INFINITY;
    if (
      best === null ||
      tried < best.tried ||
      (tried === best.tried && (close < best.close || (close === best.close && id < best.id)))
    )
      best = { id, close, tried };
  }
  if (best === null) return null;
  return { roundId: best.id, anchorAt: Number(best.close - duration), closeAt: Number(best.close) };
}

// ---------------------------------------------------------------------------------------------------------
// Fetching reports (SPEC §5.5 step 2): signing and a NARROW reading of the answer
// ---------------------------------------------------------------------------------------------------------

export const reportPath = (boundary: number, feedId: string = FEED_ID): string =>
  `/api/v1/reports?feedID=${feedId}&timestamp=${boundary}`;

/// The string Chainlink's HMAC scheme signs for a GET, as the committed probe
/// (mako-design/scripts/datastreams-retention.mjs) signs it: method, path, body hash, key, timestamp (ms).
export const signingString = (path: string, apiKey: string, timestampMs: string): string =>
  `GET ${path} ${EMPTY_BODY_SHA256} ${apiKey} ${timestampMs}`;

/// HMAC-SHA256(secret, message) as lowercase hex. Injected: WebCrypto in the Worker, the SDK's in CRE.
export type HmacHex = (secret: string, message: string) => Promise<string>;

export async function reportHeaders(
  path: string,
  apiKey: string,
  secret: string,
  timestampMs: string,
  hmac: HmacHex,
): Promise<Record<string, string>> {
  const signature = await hmac(secret, signingString(path, apiKey, timestampMs));
  return { Authorization: apiKey, 'X-Authorization-Timestamp': timestampMs, 'X-Authorization-Signature-SHA256': signature };
}

/// The only things a report error may carry: never the request, the headers, the key or the provider's text
/// (SPEC §5.5 step 2), so nothing sensitive can reach a log, an alert or stored state.
export type ReportReason = 'not_found' | 'unauthorized' | 'rate_limited' | 'server_error' | 'bad_status' | 'bad_body' | 'mismatch';
export type ReportResult =
  | { ok: true; fullReport: Hex }
  | { ok: false; status: number; reason: ReportReason; requestId: string | null };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/// Reads one API answer for boundary `boundary`. A report is accepted only if it is for FEED_ID and was
/// observed at exactly `boundary`, the same rule the contract applies (§5.2 step 5), so a wrong report is
/// caught here instead of costing a reverted transaction.
export function readReport(status: number, body: string, requestIdHeader: string | null, boundary: number): ReportResult {
  const requestId = requestIdHeader !== null && REQUEST_ID.test(requestIdHeader) ? requestIdHeader : null;
  const fail = (reason: ReportReason): ReportResult => ({ ok: false, status, reason, requestId });
  if (status === 404) return fail('not_found');
  if (status === 401 || status === 403) return fail('unauthorized');
  if (status === 429) return fail('rate_limited');
  if (status >= 500 && status <= 599) return fail('server_error');
  if (status !== 200) return fail('bad_status');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail('bad_body');
  }
  const r = (parsed as { report?: Record<string, unknown> } | null)?.report;
  if (!r || typeof r !== 'object') return fail('bad_body');
  const full = r.fullReport;
  if (typeof full !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(full)) return fail('bad_body');
  if (typeof r.feedID !== 'string' || r.feedID.toLowerCase() !== FEED_ID) return fail('mismatch');
  if (Number(r.observationsTimestamp) !== boundary) return fail('mismatch');
  return { ok: true, fullReport: full.toLowerCase() as Hex };
}

// ---------------------------------------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------------------------------------

export const settleData = (roundId: bigint, anchorReport: Hex, closeReport: Hex): Hex =>
  encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'settle', args: [roundId, anchorReport, closeReport] });

/// A revert's custom-error name from MakoRoundsV1 (or its settlement library), or null if it is not one.
export function revertName(data: unknown): string | null {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return null;
  try {
    return decodeErrorResult({ abi: ROUNDS_ABI, data: data as Hex }).errorName;
  } catch {
    return null;
  }
}
