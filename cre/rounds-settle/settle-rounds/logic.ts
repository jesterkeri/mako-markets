// Pure logic for the rounds-settle CRE workflow. No capability calls, no clock, no secrets of its own:
// main.ts does the I/O and passes values in, so everything here is unit-tested directly (test/logic.test.ts).
//
// The Data Streams request signing, the narrow reading of a report answer and the round-picking rule are
// ported from the reviewed keeper code on origin/feat/rounds-keeper:rounds-delivery/src/index.ts (25e02c0),
// so the CRE path and the Cloudflare keeper ask for, accept and refuse exactly the same reports. Two changes,
// both forced by CRE and both stated where they happen:
//   1. HMAC is computed with @noble/hashes (pure JS), because the CRE WASM runtime has no WebCrypto, and it is
//      synchronous because CRE handlers are synchronous.
//   2. A CRE workflow keeps no state between runs, so the keeper's "least recently tried" memory is replaced
//      by a stateless rotation over the due rounds keyed on the minute (pickRound below).

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { utf8ToBytes } from '@noble/hashes/utils';
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from 'viem';
import { ROUNDS_ABI } from './rounds-abi';

export { ROUNDS_ABI };

/// BTC/USD on the Data Streams testnet. The rounds contract pins the same id and refuses any other feed
/// on-chain; it is refused here first so a wrong report never costs gas.
export const FEED_ID = '0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439' as const;

/// sha256 of the empty body, hex: the third field of Chainlink's HMAC string for a GET.
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------

export type Config = {
  /// Six-field CRE cron (seconds first).
  schedule: string;
  /// CRE chain selector name; "monad-testnet" is chain id 10143.
  chainSelectorName: string;
  /// MakoRoundsV1, read for due rounds.
  roundsAddress: string;
  /// MakoRoundsCreAdapter, the receiver of the signed report. Empty until the adapter is deployed: the
  /// workflow then still reads and fetches, and stops with a clear error at the write step.
  adapterAddress: string;
  /// Data Streams REST origin, HTTPS, no trailing slash.
  dataStreamsUrl: string;
  /// Seconds past closeTime before a round is attempted, so the close report has been published.
  settleDelaySeconds: number;
  /// Gas limit for the forwarder's call into the adapter (settle verifies two reports).
  gasLimit: string;
};

export type CheckedConfig = Omit<Config, 'roundsAddress' | 'adapterAddress'> & {
  roundsAddress: Address;
  /// null when config.adapterAddress is empty (adapter not deployed yet).
  adapterAddress: Address | null;
};

/// Validates the config once per run. Throws naming the FIELD only, never echoing a value.
export function checkConfig(c: Config): CheckedConfig {
  const addr = (v: unknown, name: string): Address => {
    if (typeof v !== 'string') throw new Error(`config.${name} is not set`);
    try {
      return getAddress(v.trim());
    } catch {
      throw new Error(`config.${name} is not a valid address`);
    }
  };
  if (typeof c.schedule !== 'string' || c.schedule.trim() === '') throw new Error('config.schedule is not set');
  if (typeof c.chainSelectorName !== 'string' || c.chainSelectorName === '') throw new Error('config.chainSelectorName is not set');
  if (typeof c.dataStreamsUrl !== 'string' || !/^https:\/\/[^/\s]+$/.test(c.dataStreamsUrl))
    throw new Error('config.dataStreamsUrl must be an https origin with no path or trailing slash');
  if (!Number.isSafeInteger(c.settleDelaySeconds) || c.settleDelaySeconds < 0 || c.settleDelaySeconds > 86_400)
    throw new Error('config.settleDelaySeconds must be an integer in [0, 86400]');
  if (typeof c.gasLimit !== 'string' || !/^[1-9][0-9]{4,7}$/.test(c.gasLimit))
    throw new Error('config.gasLimit must be a decimal string between 10000 and 99999999');
  const roundsAddress = addr(c.roundsAddress, 'roundsAddress');
  const adapterAddress =
    typeof c.adapterAddress === 'string' && c.adapterAddress.trim() === '' ? null : addr(c.adapterAddress, 'adapterAddress');
  if (roundsAddress === adapterAddress) throw new Error('config.adapterAddress must differ from config.roundsAddress');
  return { ...c, roundsAddress, adapterAddress };
}

// ---------------------------------------------------------------------------------------------------------
// Reading the rounds contract
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
  BigInt(decodeFunctionResult({ abi: ROUNDS_ABI, functionName: 'closeTimeOf', data }));

export interface Due {
  roundId: bigint;
  /// The two boundary seconds whose reports settle it: B = startTime (anchor) and B = closeTime (close).
  anchorAt: number;
  closeAt: number;
}

/// Multicall3, the canonical deployment (same address on every EVM chain; runtime code present on Monad testnet,
/// checked 2026-10-10). The deployed MakoRoundsV1 returns only ids from pendingSettlement(), so the close times
/// come from one aggregate3 call: a run makes 2 EVM reads in all, within SPEC §5.5a / N24's "at most 3".
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const MULTICALL3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    // payable on chain; declared view here because it is only ever eth_call-ed (the selector is unchanged).
    stateMutability: 'view',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/// Close times read per run. MakoRoundsV1 caps active rounds at MAX_ACTIVE_ROUNDS = 10, so today every pending
/// round fits; past this, a rotating window (candidateIds) still reaches every id.
export const MAX_CLOSE_READS = 50;

/// One aggregate3 call: DURATION() first (may not fail), then closeTimeOf(id) per id (may fail: a round can
/// leave pendingSettlement between the two reads, and that id is then skipped for this run).
export function roundTimesData(rounds: Address, ids: readonly bigint[]): Hex {
  const calls = [
    { target: rounds, allowFailure: false, callData: durationData() },
    ...ids.map((id) => ({ target: rounds, allowFailure: true, callData: closeTimeData(id) })),
  ];
  return encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [calls] });
}

/// Decodes roundTimesData's answer. Throws if the shape is wrong or DURATION failed; a failed or undecodable
/// closeTimeOf leaves that id out of `closeTimes`, so dueRounds skips it.
export function decodeRoundTimes(data: Hex, ids: readonly bigint[]): { duration: bigint; closeTimes: Map<bigint, bigint> } {
  const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data });
  if (results.length !== ids.length + 1) throw new Error(`aggregate3 returned ${results.length} results for ${ids.length + 1} calls`);
  if (!results[0].success) throw new Error('DURATION() failed inside aggregate3');
  const duration = decodeDuration(results[0].returnData);
  const closeTimes = new Map<bigint, bigint>();
  ids.forEach((id, i) => {
    const r = results[i + 1];
    if (!r.success) return;
    try {
      closeTimes.set(id, decodeCloseTime(r.returnData));
    } catch {
      // A malformed answer is treated like a failed call: the round waits for a later run.
    }
  });
  return { duration, closeTimes };
}

/// The pending ids whose close time this run reads. All of them when they fit; otherwise a window of
/// `max` ids that rotates with the minute, so no pending round is left unread for good.
export function candidateIds(pending: readonly bigint[], nowS: number, max: number, periodS = 60): bigint[] {
  const unique = [...new Set(pending)];
  if (unique.length <= max) return unique;
  const start = Math.floor(nowS / periodS) % unique.length;
  const out: bigint[] = [];
  for (let i = 0; i < max; i++) out.push(unique[(start + i) % unique.length]);
  return out;
}

/// Rounds from `pendingSettlement()` that are at least `delayS` past close, ordered by close time then id.
export function dueRounds(
  pending: readonly bigint[],
  closeTimes: ReadonlyMap<bigint, bigint>,
  duration: bigint,
  nowS: number,
  delayS: number,
): Due[] {
  const out: { id: bigint; close: bigint }[] = [];
  const seen = new Set<bigint>();
  for (const id of pending) {
    if (seen.has(id)) continue;
    seen.add(id);
    const close = closeTimes.get(id);
    if (close === undefined) continue;
    if (BigInt(nowS) < close + BigInt(delayS)) continue;
    out.push({ id, close });
  }
  out.sort((a, b) => (a.close !== b.close ? (a.close < b.close ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.map(({ id, close }) => ({ roundId: id, anchorAt: Number(close - duration), closeAt: Number(close) }));
}

/// The one round this run settles, or null when nothing is due.
///
/// The keeper takes turns using a per-round "last tried" memory, so a round that cannot settle (report
/// missing, spread too wide) spends only its own turn and never blocks the rounds behind it until their
/// deadline (adversary pass on the keeper, 2026-09-28). A CRE workflow has no memory between runs, so the
/// same guarantee comes from rotating on the minute: run k takes due[k mod n]. With n due rounds and one run
/// a minute, every due round is attempted at least once every n minutes, whatever the others do.
export function pickRound(due: readonly Due[], nowS: number, periodS = 60): Due | null {
  if (due.length === 0) return null;
  const turn = Math.floor(nowS / periodS) % due.length;
  return due[turn];
}

// ---------------------------------------------------------------------------------------------------------
// Fetching reports: signing and a NARROW reading of the answer
// ---------------------------------------------------------------------------------------------------------

export const reportPath = (boundary: number, feedId: string = FEED_ID): string =>
  `/api/v1/reports?feedID=${feedId}&timestamp=${boundary}`;

/// The string Chainlink's HMAC scheme signs for a GET: method, path, body hash, key, timestamp (ms).
export const signingString = (path: string, apiKey: string, timestampMs: string): string =>
  `GET ${path} ${EMPTY_BODY_SHA256} ${apiKey} ${timestampMs}`;

/// HMAC-SHA256(secret, message) as lowercase hex, synchronous and pure JS (no WebCrypto in CRE's WASM).
export function hmacSha256Hex(secret: string, message: string): string {
  const mac = hmac(sha256, utf8ToBytes(secret), utf8ToBytes(message));
  let out = '';
  for (const b of mac) out += b.toString(16).padStart(2, '0');
  return out;
}

export function reportHeaders(path: string, apiKey: string, secret: string, timestampMs: string): Record<string, string> {
  return {
    Authorization: apiKey,
    'X-Authorization-Timestamp': timestampMs,
    'X-Authorization-Signature-SHA256': hmacSha256Hex(secret, signingString(path, apiKey, timestampMs)),
  };
}

/// The only things a report error may carry: never the request, the headers, the key or the provider's text,
/// so nothing sensitive can reach a log or the workflow result.
export type ReportReason = 'not_found' | 'unauthorized' | 'rate_limited' | 'server_error' | 'bad_status' | 'bad_body' | 'mismatch';
export type ReportResult =
  | { ok: true; fullReport: Hex }
  | { ok: false; status: number; reason: ReportReason; requestId: string | null };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/// Reads one API answer for boundary `boundary`. A report is accepted only if it is for FEED_ID and was
/// observed at exactly `boundary`, the same rule the contract applies, so a wrong report is caught here
/// instead of costing a reverted transaction.
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
// The report CRE signs and the adapter decodes
// ---------------------------------------------------------------------------------------------------------

/// The adapter's `onReport` decodes exactly `abi.decode(report, (uint256, bytes, bytes))`.
export const SETTLE_REPORT_PARAMS = [
  { name: 'roundId', type: 'uint256' },
  { name: 'anchorReport', type: 'bytes' },
  { name: 'closeReport', type: 'bytes' },
] as const;

export const encodeSettleReport = (roundId: bigint, anchorReport: Hex, closeReport: Hex): Hex =>
  encodeAbiParameters(SETTLE_REPORT_PARAMS, [roundId, anchorReport, closeReport]);

export const decodeSettleReport = (data: Hex): readonly [bigint, Hex, Hex] =>
  decodeAbiParameters(SETTLE_REPORT_PARAMS, data);

/// The calldata the adapter forwards, for comparison in tests: rounds.settle(roundId, anchor, close).
export const settleData = (roundId: bigint, anchorReport: Hex, closeReport: Hex): Hex =>
  encodeFunctionData({ abi: ROUNDS_ABI, functionName: 'settle', args: [roundId, anchorReport, closeReport] });

