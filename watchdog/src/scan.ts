// The market scan at one finalized block (r15 §5.1, with the bounded-prefix
// creation cursor from the 2026-09-19 review).
//
// Plan: the prefix [creationCursor, min(N, creationCursor + ID_BUDGET)) is
// read first; only the budget left over goes to the rotating window, and
// rotating reads never move the creation cursor. While N <= ID_BUDGET the
// leftover always covers [0, creationCursor), so every id below N is read.

import { CALLS_PER_REQUEST, CHAIN_ID, ID_BUDGET, IDS_PER_CALL, MAX_PAGE_REQUESTS, MULTICALL3 } from './config';
import { aggregate3GetMarkets, decodeAddressWord, decodeAggregate3, decodeMarketHead, decodeUintWord, SEL, type MarketHead } from './abi';
import type { Net } from './net';
import { hexQuantity, rpcBatch, type RpcCall } from './rpc';

export interface ScanPlan {
  /// The stored cursor. Above N only if a provider reported N going backwards.
  creationCursor: number;
  prefixStart: number;
  prefixEnd: number;
  /// Ids to read, prefix first, then the rotating window. At most ID_BUDGET.
  ids: number[];
  rotatingCount: number;
}

export function planScan(n: number, creationCursor: number, runIndex: number): ScanPlan {
  const prefixStart = Math.min(creationCursor, n);
  const prefixEnd = Math.max(prefixStart, Math.min(n, creationCursor + ID_BUDGET));
  const ids: number[] = [];
  for (let id = prefixStart; id < prefixEnd; id++) ids.push(id);
  const leftover = ID_BUDGET - ids.length;
  const outside = n - ids.length;
  const take = Math.min(leftover, outside);
  if (take > 0) {
    // Rotating window over the ids outside the prefix. In-envelope this is
    // all of [0, prefixStart) ∪ [prefixEnd, n).
    const start = n > ID_BUDGET ? (runIndex * ID_BUDGET) % n : 0;
    let got = 0;
    for (let j = 0; got < take && j < n; j++) {
      const id = (start + j) % n;
      if (id >= prefixStart && id < prefixEnd) continue;
      ids.push(id);
      got++;
    }
  }
  return { creationCursor, prefixStart, prefixEnd, ids, rotatingCount: ids.length - (prefixEnd - prefixStart) };
}

/// Pages of at most CALLS_PER_REQUEST aggregate3 calls of IDS_PER_CALL ids.
export function pageRequests(ids: number[]): number[][][] {
  const calls: number[][] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) calls.push(ids.slice(i, i + IDS_PER_CALL));
  const pages: number[][][] = [];
  for (let i = 0; i < calls.length; i += CALLS_PER_REQUEST) pages.push(calls.slice(i, i + CALLS_PER_REQUEST));
  if (pages.length > MAX_PAGE_REQUESTS) throw new Error('scan: plan exceeds the page budget');
  return pages;
}

export interface Discovery {
  chainId: number;
  latestBlock: number;
  finalizedBlock: number;
  finalizedTimestamp: number;
  nextMarketId: number;
  resolver: string | null; // lowercase
  resolverBalanceWei: bigint | null;
}

export type DiscoveryResult = { ok: true; value: Discovery } | { ok: false; reason: string };

/// One provider-B request: chain id, latest block, the finalized block, and
/// nextMarketId, resolver() and the resolver's balance at `finalized`.
export async function discover(net: Net, url: string, mako: string, resolverAddr: string): Promise<DiscoveryResult> {
  const calls: RpcCall[] = [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getBlockByNumber', params: ['finalized', false] },
    { method: 'eth_call', params: [{ to: mako, data: '0x' + SEL.nextMarketId }, 'finalized'] },
    { method: 'eth_call', params: [{ to: mako, data: '0x' + SEL.resolver }, 'finalized'] },
    { method: 'eth_getBalance', params: [resolverAddr, 'finalized'] },
  ];
  const b = await rpcBatch(net, url, calls);
  if (!b.ok) return { ok: false, reason: b.kind };
  const [chain, latest, fin, next, res, bal] = b.items;
  if (!chain.ok || !latest.ok || !fin.ok || !next.ok) return { ok: false, reason: 'call_failed' };
  const chainId = hexQuantity(chain.result);
  const latestBlock = hexQuantity(latest.result);
  const block = fin.result as { number?: unknown; timestamp?: unknown } | null;
  const finalizedBlock = hexQuantity(block?.number);
  const finalizedTimestamp = hexQuantity(block?.timestamp);
  const nextMarketId = decodeUintWord(next.result);
  if (chainId === null || latestBlock === null || finalizedBlock === null || finalizedTimestamp === null || nextMarketId === null) {
    return { ok: false, reason: 'bad_response' };
  }
  if (nextMarketId > 1_000_000n) return { ok: false, reason: 'bad_response' };
  return {
    ok: true,
    value: {
      chainId: Number(chainId),
      latestBlock: Number(latestBlock),
      finalizedBlock: Number(finalizedBlock),
      finalizedTimestamp: Number(finalizedTimestamp),
      nextMarketId: Number(nextMarketId),
      resolver: res.ok ? decodeAddressWord(res.result) : null,
      resolverBalanceWei: bal.ok ? hexQuantity(bal.result) : null,
    },
  };
}

export function chainOk(d: Discovery): boolean {
  return d.chainId === CHAIN_ID;
}

export interface PageOutcome {
  /// Every id of the plan: its head, or null when it was not read.
  reads: Map<number, MarketHead | null>;
  failedRequests: number;
  requests: number;
}

/// Reads the plan's ids at one block, one request in flight (F26). A failed
/// request, a failed call inside aggregate3, a decode error, or a zero
/// closeTime below N (a market cannot have one) all leave the id unread.
export async function readPages(net: Net, url: string, mako: string, blockNumber: number, n: number, ids: number[]): Promise<PageOutcome> {
  const reads = new Map<number, MarketHead | null>();
  for (const id of ids) reads.set(id, null);
  const blockTag = '0x' + blockNumber.toString(16);
  let failedRequests = 0;
  let requests = 0;
  for (const page of pageRequests(ids)) {
    requests++;
    const calls: RpcCall[] = page.map((chunk) => ({
      method: 'eth_call',
      params: [{ to: MULTICALL3, data: aggregate3GetMarkets(mako, chunk) }, blockTag],
    }));
    const b = await rpcBatch(net, url, calls);
    if (!b.ok) {
      failedRequests++;
      continue;
    }
    page.forEach((chunk, i) => {
      const item = b.items[i];
      if (!item.ok || typeof item.result !== 'string') return;
      let datas: (string | null)[];
      try {
        datas = decodeAggregate3(item.result, chunk.length);
      } catch {
        return;
      }
      chunk.forEach((id, k) => {
        const data = datas[k];
        if (data === null) return;
        try {
          const head = decodeMarketHead(id, data);
          if (head.closeTime === 0 && id < n) return;
          reads.set(id, head);
        } catch {
          // unread
        }
      });
    });
  }
  return { reads, failedRequests, requests };
}

/// The creation cursor after this run's reads: the end of the contiguous run
/// of successfully read prefix ids, stopping early at `stopAt` (the first id
/// whose creation alert was not confirmed). Rotating reads never count.
export function advanceCursor(plan: ScanPlan, reads: Map<number, MarketHead | null>, stopAt: number | null): number {
  if (plan.creationCursor > plan.prefixStart) return plan.creationCursor; // N went backwards: never move
  let c = plan.prefixStart;
  while (c < plan.prefixEnd && reads.get(c)) {
    if (stopAt !== null && c >= stopAt) break;
    c++;
  }
  return c;
}
