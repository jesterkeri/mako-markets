// A list of JSON-RPC calls, sent one call per request; adapted from watchdog/src/rpc.ts (feat/watchdog-slice1). A
// rate-limit answer (HTTP 429 or JSON-RPC -32011/-32005) is its own kind, so a limited public RPC is reported
// as rate-limited, never mistaken for "nothing to settle".

import { send, type FailKind, type Net } from './net';

export interface RpcCall {
  method: string;
  params: unknown[];
}

/// `data` is the error's revert payload when there is one, so a simulated `settle` decodes to its custom error.
export type RpcItem = { ok: true; result: unknown } | { ok: false; kind: FailKind | 'rpc_error'; code?: number; data?: unknown };

export type RpcBatch = { ok: true; items: RpcItem[] } | { ok: false; kind: FailKind; status?: number };

const RATE_LIMIT_CODES = new Set([-32011, -32005, 429]);

/// Gap between two calls of one run, so a run stays under 10 calls a second (the public RPC allows about 15 items).
export const CALL_SPACING_MS = 110;
const lastCall = new WeakMap<Net, number>();

/// Same result as the array batch it replaced, item i for call i, but each call is its own request: since 2026-11-03
/// the public Monad RPC answers any JSON-RPC array body with HTTP 403 "Restricted JSON RPC method". A failed request,
/// an unreadable answer, or an error object without the call's id fails the whole list, as a failed batch did, and
/// the remaining calls are not sent; an error answer to one call fails that item only, as before.
export async function rpcBatch(net: Net, url: string, calls: RpcCall[]): Promise<RpcBatch> {
  const items: RpcItem[] = [];
  for (let i = 0; i < calls.length; i++) {
    const last = lastCall.get(net);
    if (last !== undefined && last + CALL_SPACING_MS > net.now()) await net.sleep(last + CALL_SPACING_MS - net.now());
    lastCall.set(net, net.now());
    const body = JSON.stringify({ jsonrpc: '2.0', id: i, method: calls[i].method, params: calls[i].params });
    const res = await send(net, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!res.ok) return { ok: false, kind: res.kind, status: res.status };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false, kind: 'bad_response' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, kind: 'bad_response' };
    const e = parsed as { id?: unknown; result?: unknown; error?: { code?: unknown; data?: unknown } | null };
    const error = e.error !== undefined && e.error !== null ? e.error : null;
    const code = typeof error?.code === 'number' ? error.code : undefined;
    const limited = code !== undefined && RATE_LIMIT_CODES.has(code);
    if (e.id !== i) {
      // Some providers answer a refused request with one error object and no id: the whole list fails.
      if (error) return { ok: false, kind: limited ? 'rate_limited' : 'bad_response' };
      items.push({ ok: false, kind: 'bad_response' });
    } else if (error) {
      items.push({ ok: false, kind: limited ? 'rate_limited' : 'rpc_error', code, data: error.data });
    } else if ('result' in e) {
      items.push({ ok: true, result: e.result });
    } else {
      items.push({ ok: false, kind: 'bad_response' });
    }
  }
  return { ok: true, items };
}

/// A 0x-prefixed hex quantity as a bigint, or null.
export function hexQuantity(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
  return BigInt(v);
}

/// A hex quantity that is a safe integer, or null.
export function safeQuantity(v: unknown): number | null {
  const q = hexQuantity(v);
  return q !== null && q <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(q) : null;
}
