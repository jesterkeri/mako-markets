// ----------------------------------------------------------------------------
// cf-worker/src/datastreams.ts
//
// Chainlink Data Streams for pool settlement (RESOLVER_PRICE_PLAN r14 §3 steps 2 to 3b, §4.2 to §4.4):
//   * fetch: the report for one feed and one second, signed with Chainlink's HMAC scheme. Ported from the Rounds
//     keeper's reviewed client (feat/rounds-keeper rounds-delivery/src/index.ts), generalized to any feed. An error
//     carries only an HTTP status, a reason and the request id: never the request, headers, key or provider text.
//   * verify: `VerifierProxy.verify(fullReport, 0x)` by eth_call on TWO providers at the same block, after checking
//     `s_feeManager()` is zero on both; both must return identical bytes. Only those returned bytes are decoded.
//   * decode: the returned bytes must be exactly 288 bytes with the pinned schema's prefix (0x0003 v3, 0x0008 v8).
// ----------------------------------------------------------------------------

import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

export const VERIFIER_PROXY = '0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64' as const;
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const REPORT_TIMEOUT_MS = 8_000;
export const VERIFY_TIMEOUT_MS = 8_000;

const verifierAbi = [
  {
    type: 'function',
    name: 'verify',
    stateMutability: 'payable',
    inputs: [
      { name: 'payload', type: 'bytes' },
      { name: 'parameterPayload', type: 'bytes' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
  { type: 'function', name: 's_feeManager', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

// ---- fetch ------------------------------------------------------------------------------------------------

export const reportPath = (feedId: string, boundary: number): string => `/api/v1/reports?feedID=${feedId}&timestamp=${boundary}`;

/// The string Chainlink's HMAC scheme signs for a GET: method, path, body hash, key, timestamp (ms).
export const signingString = (path: string, apiKey: string, timestampMs: string): string =>
  `GET ${path} ${EMPTY_BODY_SHA256} ${apiKey} ${timestampMs}`;

export type HmacHex = (secret: string, message: string) => Promise<string>;

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function reportHeaders(path: string, apiKey: string, secret: string, timestampMs: string, hmac: HmacHex): Promise<Record<string, string>> {
  const signature = await hmac(secret, signingString(path, apiKey, timestampMs));
  return { Authorization: apiKey, 'X-Authorization-Timestamp': timestampMs, 'X-Authorization-Signature-SHA256': signature };
}

export type ReportReason = 'report_missing' | 'unauthorized' | 'rate_limited' | 'server_error' | 'bad_status' | 'bad_body' | 'mismatch' | 'network';
export type ReportResult = { ok: true; fullReport: Hex } | { ok: false; status: number; reason: ReportReason; requestId: string | null };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/// One API answer for `feedId` at second `boundary`. A report is accepted only for that feed and observed at exactly
/// that second; authenticity is decided later by the verifier, never here.
export function readReport(status: number, body: string, requestIdHeader: string | null, feedId: string, boundary: number): ReportResult {
  const requestId = requestIdHeader !== null && REQUEST_ID.test(requestIdHeader) ? requestIdHeader : null;
  const fail = (reason: ReportReason): ReportResult => ({ ok: false, status, reason, requestId });
  if (status === 404) return fail('report_missing');
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
  if (typeof r.feedID !== 'string' || r.feedID.toLowerCase() !== feedId.toLowerCase()) return fail('mismatch');
  if (Number(r.observationsTimestamp) !== boundary) return fail('mismatch');
  return { ok: true, fullReport: full.toLowerCase() as Hex };
}

export type ReportCredentials = { apiKey: string; secret: string };

/// Fetches one report. Never throws; the result is narrow by construction.
export async function fetchReport(args: {
  fetchImpl: typeof fetch;
  base: string;
  creds: ReportCredentials;
  feedId: string;
  boundary: number;
  nowMs: number;
  hmac?: HmacHex;
}): Promise<ReportResult> {
  const path = reportPath(args.feedId, args.boundary);
  try {
    const headers = await reportHeaders(path, args.creds.apiKey, args.creds.secret, String(args.nowMs), args.hmac ?? hmacSha256Hex);
    const res = await args.fetchImpl(`${args.base.replace(/\/$/, '')}${path}`, { headers, signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) });
    return readReport(res.status, await res.text(), res.headers.get('x-request-id'), args.feedId, args.boundary);
  } catch {
    return { ok: false, status: 0, reason: 'network', requestId: null };
  }
}

// ---- verify -----------------------------------------------------------------------------------------------

export type RpcCall = (to: string, data: Hex, block: bigint) => Promise<{ ok: true; result: Hex } | { ok: false; revert: boolean }>;

/// One eth_call over HTTP JSON-RPC, never throwing: a JSON-RPC error that is a revert (code 3, or "execution
/// reverted") is told apart from an unavailable provider.
export function httpEthCall(url: string): RpcCall {
  return async (to, data, block) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, `0x${block.toString(16)}`] }),
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, revert: false };
      const body = (await res.json()) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
      if (typeof body.result === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(body.result)) return { ok: true, result: body.result.toLowerCase() as Hex };
      const msg = typeof body.error?.message === 'string' ? body.error.message : '';
      return { ok: false, revert: body.error?.code === 3 || /revert/i.test(msg) };
    } catch {
      return { ok: false, revert: false };
    }
  };
}

export type VerifyReason = 'verify_failed' | 'providers_disagree' | 'verifier_unavailable' | 'fee_manager_set';
export type VerifyResult = { ok: true; verified: Hex } | { ok: false; reason: VerifyReason };

const ZERO_ADDRESS_WORD = `0x${'0'.repeat(64)}`;

/// The verified bytes, agreed by both providers at `block`, or why not.
export async function verifyOnBoth(providers: readonly [RpcCall, RpcCall], fullReport: Hex, block: bigint): Promise<VerifyResult> {
  const feeData = encodeFunctionData({ abi: verifierAbi, functionName: 's_feeManager' });
  const fees = await Promise.all(providers.map((p) => p(VERIFIER_PROXY, feeData, block)));
  if (fees.some((f) => !f.ok)) return { ok: false, reason: 'verifier_unavailable' };
  if (fees.some((f) => f.ok && f.result !== ZERO_ADDRESS_WORD)) return { ok: false, reason: 'fee_manager_set' };
  const data = encodeFunctionData({ abi: verifierAbi, functionName: 'verify', args: [fullReport, '0x'] });
  const answers = await Promise.all(providers.map((p) => p(VERIFIER_PROXY, data, block)));
  if (answers.some((a) => !a.ok && a.revert)) return { ok: false, reason: 'verify_failed' };
  if (answers.some((a) => !a.ok)) return { ok: false, reason: 'verifier_unavailable' };
  const [a, b] = answers as [{ ok: true; result: Hex }, { ok: true; result: Hex }];
  if (a.result !== b.result) return { ok: false, reason: 'providers_disagree' };
  let verified: Hex;
  try {
    verified = decodeFunctionResult({ abi: verifierAbi, functionName: 'verify', data: a.result });
  } catch {
    return { ok: false, reason: 'verify_failed' };
  }
  return { ok: true, verified: verified.toLowerCase() as Hex };
}

// ---- decode -----------------------------------------------------------------------------------------------

export type V3Report = {
  schema: 3;
  feedId: Hex;
  validFromTimestamp: number;
  observationsTimestamp: number;
  expiresAt: number;
  price: bigint;
  bid: bigint;
  ask: bigint;
};
export type V8Report = {
  schema: 8;
  feedId: Hex;
  validFromTimestamp: number;
  observationsTimestamp: number;
  expiresAt: number;
  lastUpdateTimestamp: bigint;
  midPrice: bigint;
  marketStatus: number;
};
export type DecodedReport = V3Report | V8Report;

const HEAD = [
  { type: 'bytes32', name: 'feedId' },
  { type: 'uint32', name: 'validFromTimestamp' },
  { type: 'uint32', name: 'observationsTimestamp' },
  { type: 'uint192', name: 'nativeFee' },
  { type: 'uint192', name: 'linkFee' },
  { type: 'uint32', name: 'expiresAt' },
] as const;
const V3 = [...HEAD, { type: 'int192', name: 'price' }, { type: 'int192', name: 'bid' }, { type: 'int192', name: 'ask' }] as const;
const V8 = [...HEAD, { type: 'uint64', name: 'lastUpdateTimestamp' }, { type: 'int192', name: 'midPrice' }, { type: 'uint32', name: 'marketStatus' }] as const;

/// Only the verifier's returned bytes, and only if they are exactly 288 bytes with the pinned schema's prefix.
export function decodeVerified(verified: Hex, schema: 3 | 8): DecodedReport | null {
  if (!/^0x[0-9a-f]{576}$/.test(verified)) return null; // 288 bytes
  const prefix = schema === 3 ? '0003' : '0008';
  if (verified.slice(2, 6) !== prefix) return null;
  try {
    if (schema === 3) {
      const v = decodeAbiParameters(V3, verified);
      return { schema: 3, feedId: v[0].toLowerCase() as Hex, validFromTimestamp: v[1], observationsTimestamp: v[2], expiresAt: v[5], price: v[6], bid: v[7], ask: v[8] };
    }
    const v = decodeAbiParameters(V8, verified);
    return { schema: 8, feedId: v[0].toLowerCase() as Hex, validFromTimestamp: v[1], observationsTimestamp: v[2], expiresAt: v[5], lastUpdateTimestamp: v[6], midPrice: v[7], marketStatus: v[8] };
  } catch {
    return null;
  }
}
