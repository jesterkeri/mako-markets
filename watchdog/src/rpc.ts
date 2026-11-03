// JSON-RPC array batches over one HTTP request (provider B), and the same
// calls one per request (rpcEach, the public RPC). A rate-limit answer (HTTP
// 429 or JSON-RPC -32011, F26) is a retryable failure and never means
// "no data".

import { send, type FailKind, type HttpResult, type Net } from './net';

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

/// Gap between two public-RPC calls of one run: under 10 a second (the public RPC allows about 15 items a second).
export const CALL_SPACING_MS = 110;
const lastCall = new WeakMap<Net, number>();

/// rpcBatch's result for the public Monad RPC, which since 2026-11-03 answers any JSON-RPC array body with HTTP 403
/// "Restricted JSON RPC method": each call is its own request, item i for call i. A failed request, an unreadable
/// answer, or an error object without the call's id fails the whole list, as a failed batch did (every call is
/// still sent, as the array's were); an error answer to one call fails that item only, as before. Provider B keeps rpcBatch.
export async function rpcEach(net: Net, url: string, calls: RpcCall[]): Promise<RpcBatch> {
  // Each call starts CALL_SPACING_MS after the one before WITHOUT waiting for its answer, so a list costs about one
  // answer time, as the array did. Waiting for each answer let a slow RPC push the keeper's send past its run deadline
  // after it had signed and recorded the transaction (adversary on b7c6aab, 2026-11-03).
  const answers: Promise<HttpResult>[] = [];
  for (let i = 0; i < calls.length; i++) {
    const last = lastCall.get(net);
    if (last !== undefined && last + CALL_SPACING_MS > net.now()) await net.sleep(last + CALL_SPACING_MS - net.now());
    lastCall.set(net, net.now());
    const body = JSON.stringify({ jsonrpc: '2.0', id: i, method: calls[i].method, params: calls[i].params });
    answers.push(send(net, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  }
  const results = await Promise.all(answers);
  const items: RpcItem[] = [];
  for (let i = 0; i < calls.length; i++) {
    const res = results[i];
    if (!res.ok) return { ok: false, kind: res.kind, status: res.status };
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false, kind: 'bad_response' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, kind: 'bad_response' };
    const e = parsed as { id?: unknown; result?: unknown; error?: { code?: unknown } | null };
    const error = e.error !== undefined && e.error !== null ? e.error : null;
    const code = typeof error?.code === 'number' ? error.code : undefined;
    const limited = code !== undefined && RATE_LIMIT_CODES.has(code);
    if (e.id !== i) {
      // Some providers answer a refused request with one error object and no id: the whole list fails.
      if (error) return { ok: false, kind: limited ? 'rate_limited' : 'bad_response' };
      items.push({ ok: false, kind: 'bad_response' });
    } else if (error) {
      items.push({ ok: false, kind: limited ? 'rate_limited' : 'rpc_error', code });
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
