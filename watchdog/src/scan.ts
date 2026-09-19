// The market scan at one finalized block (r15 §5.1, with the bounded-prefix
// creation cursor from the 2026-09-19 review).
//
// Plan: the prefix [creationCursor, min(N, creationCursor + ID_BUDGET)) is
// read first; only the budget left over goes to the rotating window, and
// rotating reads never move the creation cursor. While N <= ID_BUDGET the
// leftover always covers [0, creationCursor), so every id below N is read.

import {
  CALLS_PER_REQUEST,
  CHAIN_ID,
  FINALIZED_MAX_AHEAD_MS,
  FINALIZED_MAX_BEHIND_MS,
  FINALIZED_MAX_LAG_BLOCKS,
  ID_BUDGET,
  IDS_PER_CALL,
  CONFIRM_IDS_PER_RUN,
  MAX_PAGE_REQUESTS,
  MULTICALL3,
} from './config';
import { aggregate3GetMarkets, decodeAddressWord, decodeAggregate3, decodeMarketHead, decodeUintWord, SEL, type MarketHead } from './abi';
import type { Net } from './net';
import { hexQuantity, rpcBatch, safeQuantity, type RpcCall } from './rpc';

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
  finalizedHash: string;
  finalizedTimestamp: number;
  nextMarketId: number;
  resolver: string | null; // lowercase
  resolverBalanceWei: bigint | null;
}

export type DiscoveryResult = { ok: true; value: Discovery } | { ok: false; reason: string };

/// One provider-B request: chain id, latest block, the finalized block, and
/// nextMarketId, resolver() and the resolver's balance at `finalized`.
///
/// Fail closed (review r1, finding 1): the answer is used for nothing
/// (no pages, no classification, no cursor, no discovery) unless the chain
/// id is 10143, every number is a safe integer, finalized <= latest within
/// FINALIZED_MAX_LAG_BLOCKS, and the finalized block's time is within
/// [now - 15 min, now + 60 s] of the Worker's clock.
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
  const chainId = safeQuantity(chain.result);
  if (chainId !== CHAIN_ID) return { ok: false, reason: `wrong chain ${chainId ?? 'unreadable'}` };
  const latestBlock = safeQuantity(latest.result);
  const block = fin.result as { number?: unknown; timestamp?: unknown; hash?: unknown } | null;
  const finalizedBlock = safeQuantity(block?.number);
  const finalizedTimestamp = safeQuantity(block?.timestamp);
  const finalizedHash = typeof block?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(block.hash) ? block.hash.toLowerCase() : null;
  const nextMarketId = decodeUintWord(next.result);
  if (latestBlock === null || finalizedBlock === null || finalizedTimestamp === null || finalizedHash === null || nextMarketId === null) {
    return { ok: false, reason: 'bad_response' };
  }
  if (nextMarketId > 1_000_000n) return { ok: false, reason: 'bad_response' };
  if (finalizedBlock > latestBlock) return { ok: false, reason: 'finalized block ahead of latest' };
  if (latestBlock - finalizedBlock > FINALIZED_MAX_LAG_BLOCKS) return { ok: false, reason: 'finalized block far behind latest' };
  const skewMs = finalizedTimestamp * 1000 - net.now();
  if (skewMs > FINALIZED_MAX_AHEAD_MS) return { ok: false, reason: 'finalized block time in the future' };
  if (-skewMs > FINALIZED_MAX_BEHIND_MS) return { ok: false, reason: 'finalized block stale (chain halted or provider behind)' };
  return {
    ok: true,
    value: {
      chainId,
      latestBlock,
      finalizedBlock,
      finalizedHash,
      finalizedTimestamp,
      nextMarketId: Number(nextMarketId),
      resolver: res.ok ? decodeAddressWord(res.result) : null,
      resolverBalanceWei: bal.ok ? hexQuantity(bal.result) : null,
    },
  };
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

export interface Confirmation {
  /// Ids whose full market head the public RPC returned identically at the
  /// same finalized block.
  confirmed: Set<number>;
  /// Ids the two providers returned differently at the same block.
  disagreed: number[];
  /// Ids asked for but not checked this run (budget), in request order.
  deferred: number[];
  /// Ids in this run's batch the public RPC failed to read (call or decode).
  unread: number[];
  /// True when the public RPC could not be used at all (down, wrong chain,
  /// another block); nothing is confirmed then.
  unavailable: boolean;
  reason: string;
}

function sameHead(a: MarketHead, b: MarketHead): boolean {
  return (
    a.mType === b.mType &&
    a.oracleRef === b.oracleRef &&
    a.createdAt === b.createdAt &&
    a.closeTime === b.closeTime &&
    a.bettingCloseTime === b.bettingCloseTime &&
    a.totalYes === b.totalYes &&
    a.totalNo === b.totalNo &&
    a.resolved === b.resolved
  );
}

/// Second-source confirmation (reviews r1 and r2): the public RPC, a
/// different operator from provider B, re-reads the given markets at provider
/// B's finalized block. An id is confirmed only if the public RPC is on chain
/// 10143, reports the same block hash and time, and returns the same decoded
/// head. Chain state at one block hash is deterministic, so any difference
/// means one provider is wrong. Used before every one-way transition (a
/// resolved bit, the creation cursor crossing an id) and before any refund
/// command. At most CONFIRM_IDS_PER_RUN ids, in the order given; the rest are
/// deferred to later runs.
export async function confirmAtBlock(net: Net, publicUrl: string, mako: string, d: Discovery, heads: MarketHead[]): Promise<Confirmation> {
  const confirmed = new Set<number>();
  const batch = heads.slice(0, CONFIRM_IDS_PER_RUN);
  const deferred = heads.slice(CONFIRM_IDS_PER_RUN).map((m) => m.id);
  const out = (reason: string, unavailable: boolean, disagreed: number[] = [], unread: number[] = []): Confirmation => ({
    confirmed,
    disagreed,
    deferred,
    unread,
    unavailable,
    reason,
  });
  if (!batch.length) return out('', false);
  const blockTag = '0x' + d.finalizedBlock.toString(16);
  const chunks: MarketHead[][] = [];
  for (let i = 0; i < batch.length; i += IDS_PER_CALL) chunks.push(batch.slice(i, i + IDS_PER_CALL));
  const b = await rpcBatch(net, publicUrl, [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_getBlockByNumber', params: [blockTag, false] },
    ...chunks.map((c) => ({
      method: 'eth_call',
      params: [{ to: MULTICALL3, data: aggregate3GetMarkets(mako, c.map((m) => m.id)) }, blockTag],
    })),
  ]);
  if (!b.ok) return out(`public RPC ${b.kind}`, true);
  const [chain, blk, ...pages] = b.items;
  if (!chain.ok || safeQuantity(chain.result) !== CHAIN_ID) return out('public RPC chain id', true);
  const block = blk.ok ? (blk.result as { hash?: unknown; timestamp?: unknown } | null) : null;
  if (typeof block?.hash !== 'string' || block.hash.toLowerCase() !== d.finalizedHash) return out('public RPC block differs', true);
  if (safeQuantity(block.timestamp) !== d.finalizedTimestamp) return out('public RPC block time differs', true);
  const disagreed: number[] = [];
  const unread: number[] = [];
  chunks.forEach((chunk, i) => {
    const item = pages[i];
    let datas: (string | null)[] | null = null;
    if (item?.ok && typeof item.result === 'string') {
      try {
        datas = decodeAggregate3(item.result, chunk.length);
      } catch {
        datas = null;
      }
    }
    chunk.forEach((mb, k) => {
      const data = datas?.[k] ?? null;
      if (data === null) {
        unread.push(mb.id);
        return;
      }
      let mp: MarketHead;
      try {
        mp = decodeMarketHead(mb.id, data);
      } catch {
        unread.push(mb.id);
        return;
      }
      if (sameHead(mp, mb)) confirmed.add(mb.id);
      else disagreed.push(mb.id);
    });
  });
  const reason = disagreed.length ? 'providers disagree at the same block' : unread.length ? 'public RPC could not read every market' : '';
  return out(reason, false, disagreed, unread);
}
