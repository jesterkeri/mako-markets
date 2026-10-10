// ----------------------------------------------------------------------------
// cf-worker/src/market-reads.ts
//
// One-request market loading (RESOLVER_PRICE_PLAN r14 §4.1, a deployment prerequisite): every market of a tick is
// read at ONE finalized block through Multicall3 `aggregate3` with `allowFailure`, at most 50 `getMarket` calls per
// aggregate and at most 4 aggregates per HTTP request (a JSON-RPC batch), so 200 markets per request and at most 10
// requests (2,000 markets). The spike that cleared this (mako-design/bench/multicall3-spike/2026-10-10.md) found that
// `getMarket` of a missing id does not revert but returns the zero struct, so `closeTime == 0` is read as missing.
//
// Failures: a failed call marks its market `market_read_failed`; a failed, oversized (> 1 MB) or malformed request
// marks all its markets `markets_unavailable`; nothing retries inside a tick.
// ----------------------------------------------------------------------------

import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const CALLS_PER_AGGREGATE = 50;
export const AGGREGATES_PER_REQUEST = 4;
export const MAX_REQUESTS = 10;
export const MAX_MARKETS = CALLS_PER_AGGREGATE * AGGREGATES_PER_REQUEST * MAX_REQUESTS;
export const MAX_RESPONSE_BYTES = 1_000_000;
/// Wait for one JSON-RPC batch before it counts as failed.
export const REQUEST_TIMEOUT_MS = 8_000;

const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
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

// viem's helpers are generic over a literal ABI; the V4 ABI arrives as JSON, so these are typed at the boundary.
const encodeCall = encodeFunctionData as unknown as (p: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex;
const decodeResult = decodeFunctionResult as unknown as (p: { abi: readonly unknown[]; functionName: string; data: Hex }) => unknown;

export type ReadFailure = 'market_read_failed' | 'markets_unavailable';
export type MarketRead<M> = { id: bigint; ok: true; market: M } | { id: bigint; ok: false; reason: ReadFailure };
export type MarketReads<M> = {
  /// The block every read used.
  block: bigint;
  reads: MarketRead<M>[];
  /// Ids below the newest MAX_MARKETS that were not read this tick (`market_cap_exceeded`).
  capExceeded: boolean;
  requests: number;
  bytes: number;
};

/// The ids to read: all of them, or the newest MAX_MARKETS.
export function idsToRead(count: bigint): { ids: bigint[]; capExceeded: boolean } {
  const first = count > BigInt(MAX_MARKETS) ? count - BigInt(MAX_MARKETS) : 0n;
  const ids: bigint[] = [];
  for (let id = first; id < count; id++) ids.push(id);
  return { ids, capExceeded: first > 0n };
}

type RpcPost = (body: string) => Promise<{ ok: boolean; text: string }>;

/// A JSON-RPC POST with a timeout, returning the raw body so its size can be checked before it is parsed.
export function httpRpc(url: string): RpcPost {
  return async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { ok: res.ok, text: await res.text() };
  };
}

/// Reads `ids` at `block`. `marketAbi` is the V4 ABI; `isMissing` says whether a decoded struct is the zero struct.
export async function readMarkets<M extends { closeTime: bigint }>(args: {
  post: RpcPost;
  mako: Address;
  marketAbi: readonly unknown[];
  ids: bigint[];
  block: bigint;
  capExceeded?: boolean;
}): Promise<MarketReads<M>> {
  const { post, mako, marketAbi, ids, block } = args;
  const reads: MarketRead<M>[] = [];
  let requests = 0;
  let bytes = 0;
  const perRequest = CALLS_PER_AGGREGATE * AGGREGATES_PER_REQUEST;
  for (let r = 0; r < ids.length && requests < MAX_REQUESTS; r += perRequest) {
    const requestIds = ids.slice(r, r + perRequest);
    const groups: bigint[][] = [];
    for (let g = 0; g < requestIds.length; g += CALLS_PER_AGGREGATE) groups.push(requestIds.slice(g, g + CALLS_PER_AGGREGATE));
    const body = JSON.stringify(
      groups.map((group, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: 'eth_call',
        params: [
          {
            to: MULTICALL3,
            data: encodeFunctionData({
              abi: aggregate3Abi,
              functionName: 'aggregate3',
              args: [
                group.map((id) => ({
                  target: mako,
                  allowFailure: true,
                  callData: encodeCall({ abi: marketAbi, functionName: 'getMarket', args: [id] }),
                })),
              ],
            }),
          },
          `0x${block.toString(16)}`,
        ],
      })),
    );
    requests++;
    const failAll = () => requestIds.forEach((id) => reads.push({ id, ok: false, reason: 'markets_unavailable' }));
    let parsed: unknown;
    try {
      const res = await post(body);
      bytes += res.text.length;
      if (!res.ok || res.text.length > MAX_RESPONSE_BYTES) {
        failAll();
        continue;
      }
      parsed = JSON.parse(res.text);
    } catch {
      failAll();
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length !== groups.length) {
      failAll();
      continue;
    }
    const byId = new Map<number, unknown>();
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'number') byId.set((item as { id: number }).id, item);
    }
    groups.forEach((group, i) => {
      const item = byId.get(i) as { result?: unknown; error?: unknown } | undefined;
      if (!item || typeof item.result !== 'string' || item.error) {
        group.forEach((id) => reads.push({ id, ok: false, reason: 'markets_unavailable' }));
        return;
      }
      let results: readonly { success: boolean; returnData: Hex }[];
      try {
        results = decodeFunctionResult({ abi: aggregate3Abi, functionName: 'aggregate3', data: item.result as Hex });
      } catch {
        group.forEach((id) => reads.push({ id, ok: false, reason: 'markets_unavailable' }));
        return;
      }
      if (results.length !== group.length) {
        group.forEach((id) => reads.push({ id, ok: false, reason: 'markets_unavailable' }));
        return;
      }
      group.forEach((id, j) => {
        const one = results[j];
        if (!one.success) {
          reads.push({ id, ok: false, reason: 'market_read_failed' });
          return;
        }
        try {
          const market = decodeResult({ abi: marketAbi, functionName: 'getMarket', data: one.returnData }) as M;
          // The spike: a missing id returns the zero struct rather than reverting.
          if (!market || market.closeTime === 0n) reads.push({ id, ok: false, reason: 'market_read_failed' });
          else reads.push({ id, ok: true, market });
        } catch {
          reads.push({ id, ok: false, reason: 'market_read_failed' });
        }
      });
    });
  }
  return { block, reads, capExceeded: args.capExceeded ?? false, requests, bytes };
}
