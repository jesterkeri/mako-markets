// ----------------------------------------------------------------------------
// #214 Notifications S1: the scan RPC gate and client (NOTIFICATIONS_PLAN r8 §3.2 "Scanning").
//
// Every RPC call a scan makes goes through one gate per route call (or seed run): at most 6 requests in flight and
// at least 125 ms between request starts, so at most 8 a second, a third of the public RPC's 25. viem's own retries
// are off, so every HTTP request is one the gate counted (with its defaults viem resends 429 and 5xx answers up to 3
// times outside any limit). The gate wraps the transport's `request` through viem's `custom` transport, so a request
// waits for the gate BEFORE its 5 s timeout starts; in `fetchFn` the timeout would already be running. Each eth_call
// chunk of a multicall is a separate request and passes the gate on its own. After `refuseAfter` (an absolute time)
// the gate rejects every new request at once with GateClosed: that is the route's hard stop.
//
// Re-exported from indexer.ts, which the plan names as its home; it lives here so the notification producers can use
// the retry helper without an import cycle through the indexer.
// ----------------------------------------------------------------------------

import { createPublicClient, custom, http, HttpRequestError, TimeoutError, type PublicClient } from 'viem';

import { monadTestnet } from '@/lib/chain';

export const GATE_MAX_IN_FLIGHT = 6;
export const GATE_SPACING_MS = 125;
export const SCAN_RPC_TIMEOUT_MS = 5_000;

/// Thrown for a request asked of the gate after its hard stop. Fails the batch at once, with no retry.
export class GateClosed extends Error {
  constructor() {
    super('rpc gate closed (hard stop reached)');
    this.name = 'GateClosed';
  }
}

export interface RpcGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export interface GateOptions {
  maxInFlight?: number;
  spacingMs?: number;
  /// Absolute ms time after which every new request is refused.
  refuseAfter?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createRpcGate(opts: GateOptions = {}): RpcGate {
  const max = opts.maxInFlight ?? GATE_MAX_IN_FLIGHT;
  const spacing = opts.spacingMs ?? GATE_SPACING_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const closed = () => opts.refuseAfter !== undefined && now() >= opts.refuseAfter;
  let inFlight = 0;
  let nextStart = -Infinity;
  const waiters: (() => void)[] = [];
  // A released slot passes straight to the next waiter, so the in-flight count never drops below the queue's demand.
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else inFlight -= 1;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (closed()) throw new GateClosed();
      if (inFlight < max) inFlight += 1;
      else await new Promise<void>((r) => waiters.push(r));
      try {
        const start = Math.max(now(), nextStart);
        nextStart = start + spacing;
        const wait = start - now();
        if (wait > 0) await sleep(wait);
        if (closed()) throw new GateClosed();
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/// The one client a route call (or seed run) scans with: viem retries off, a 5 s timeout that starts after the gate.
export function createScanClient(rpcUrl: string, refuseAfter?: number): PublicClient {
  const gate = createRpcGate({ refuseAfter });
  const inner = http(rpcUrl, { retryCount: 0, timeout: SCAN_RPC_TIMEOUT_MS })({ chain: monadTestnet, retryCount: 0 });
  const transport = custom({ request: (args) => gate.run(() => inner.request(args)) }, { retryCount: 0 });
  return createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
}

// ---- Error classes (plan §3.2 "Rate limits", r4) ---------------------------

export type RpcErrorClass = 'retry' | 'gate' | 'other';

/// 'retry': a -32011 or 429 code anywhere in the cause chain; an HTTP 429, a 5xx, or no answer at all; a timeout.
/// 'gate': the hard stop. 'other': everything else (for getLogs, the range-cap halving path).
export function classifyRpcError(err: unknown): RpcErrorClass {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && typeof e === 'object' && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    if (e instanceof GateClosed) return 'gate';
    const code = (e as { code?: unknown }).code;
    if (code === -32011 || code === 429) return 'retry';
    if (e instanceof TimeoutError) return 'retry';
    if (e instanceof HttpRequestError) {
      const s = e.status;
      if (s === undefined || s === 429 || (s >= 500 && s <= 599)) return 'retry';
    }
  }
  return 'other';
}

/// Retry delays: the same request again after 1 s, then after 2 s; a third failure is final.
export const RPC_RETRY_DELAYS_MS = [1_000, 2_000] as const;

export async function withRpcRetry<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = realSleep): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (classifyRpcError(err) !== 'retry' || attempt >= RPC_RETRY_DELAYS_MS.length) throw err;
      await sleep(RPC_RETRY_DELAYS_MS[attempt]);
    }
  }
}
