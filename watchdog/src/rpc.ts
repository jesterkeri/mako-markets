// JSON-RPC array batches over one HTTP request. A rate-limit answer (HTTP
// 429 or JSON-RPC -32011, F26) is a retryable failure and never means
// "no data".

import { send, type FailKind, type Net } from './net';

export interface RpcCall {
  method: string;
  params: unknown[];
}

export type RpcItem = { ok: true; result: unknown } | { ok: false; kind: FailKind | 'rpc_error'; code?: number };

export type RpcBatch = { ok: true; items: RpcItem[] } | { ok: false; kind: FailKind; status?: number };

const RATE_LIMIT_CODES = new Set([-32011, -32005, 429]);

export async function rpcBatch(net: Net, url: string, calls: RpcCall[]): Promise<RpcBatch> {
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params })));
  const res = await send(net, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!res.ok) return { ok: false, kind: res.kind, status: res.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ok: false, kind: 'bad_response' };
  }
  if (!Array.isArray(parsed)) {
    // Some providers answer a whole batch with one error object.
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    return { ok: false, kind: typeof code === 'number' && RATE_LIMIT_CODES.has(code) ? 'rate_limited' : 'bad_response' };
  }
  const items: RpcItem[] = calls.map(() => ({ ok: false, kind: 'bad_response' }) as RpcItem);
  for (const entry of parsed as unknown[]) {
    const e = entry as { id?: unknown; result?: unknown; error?: { code?: unknown } };
    if (typeof e?.id !== 'number' || !Number.isInteger(e.id) || e.id < 0 || e.id >= calls.length) continue;
    if (e.error !== undefined && e.error !== null) {
      const code = typeof e.error.code === 'number' ? e.error.code : undefined;
      items[e.id] = { ok: false, kind: code !== undefined && RATE_LIMIT_CODES.has(code) ? 'rate_limited' : 'rpc_error', code };
    } else if ('result' in e) {
      items[e.id] = { ok: true, result: e.result };
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
