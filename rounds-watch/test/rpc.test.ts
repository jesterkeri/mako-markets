// rpcBatch against an RPC that answers as the public Monad RPC does since 2026-11-03: single calls only, any array
// body is refused with HTTP 403 "Restricted JSON RPC method", about 15 items a second.

import { describe, expect, it } from 'vitest';
import { makeNet } from '../src/net';
import { CALL_SPACING_MS, rpcBatch } from '../src/rpc';

function world(answer: (body: { id: number; method: string }) => Response) {
  const clock = { t: 1_000_000 };
  const sentAt: number[] = [];
  const bodies: unknown[] = [];
  const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    sentAt.push(clock.t);
    clock.t += 5; // each request takes 5 ms
    if (Array.isArray(body)) return new Response('Restricted JSON RPC method', { status: 403 });
    return answer(body);
  }) as typeof fetch;
  const net = makeNet(fetchFn, () => clock.t, async (ms) => void (clock.t += ms), clock.t + 40_000, 50);
  return { net, sentAt, bodies };
}

const ok = (b: { id: number; method: string }) => Response.json({ jsonrpc: '2.0', id: b.id, result: b.method });

describe('rpcBatch, one call per request', () => {
  it('sends one JSON-RPC object per call and keeps the result order', async () => {
    const w = world(ok);
    const r = await rpcBatch(w.net, 'https://rpc.test', [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_gasPrice', params: [] },
    ]);
    expect(w.bodies.every((b) => !Array.isArray(b))).toBe(true);
    expect(r).toEqual({ ok: true, items: ['eth_chainId', 'eth_blockNumber', 'eth_gasPrice'].map((result) => ({ ok: true, result })) });
  });

  it('stays under 10 calls a second, across lists sent in one run', async () => {
    const w = world(ok);
    const calls = Array.from({ length: 6 }, () => ({ method: 'eth_chainId', params: [] }));
    await rpcBatch(w.net, 'https://rpc.test', calls);
    await rpcBatch(w.net, 'https://rpc.test', calls);
    const gaps = w.sentAt.slice(1).map((t, i) => t - w.sentAt[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(CALL_SPACING_MS);
    expect(CALL_SPACING_MS).toBeGreaterThan(100);
  });

  it('fails the whole list on a refused request, and sends nothing after it', async () => {
    const w = world((b) => (b.method === 'eth_blockNumber' ? new Response('Restricted JSON RPC method', { status: 403 }) : ok(b)));
    const r = await rpcBatch(w.net, 'https://rpc.test', [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_gasPrice', params: [] },
    ]);
    expect(r).toEqual({ ok: false, kind: 'http', status: 403 });
    expect(w.bodies).toHaveLength(2);
  });

  it('maps a rate-limit error object without an id to a rate-limited list, and an item error to that item only', async () => {
    const limited = world(() => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32011, message: 'requests limited to 15/sec' } }));
    expect(await rpcBatch(limited.net, 'https://rpc.test', [{ method: 'eth_chainId', params: [] }])).toEqual({ ok: false, kind: 'rate_limited' });

    const reverted = world((b) =>
      b.method === 'eth_call' ? Response.json({ jsonrpc: '2.0', id: b.id, error: { code: 3, data: '0xdeadbeef' } }) : ok(b),
    );
    const r = await rpcBatch(reverted.net, 'https://rpc.test', [
      { method: 'eth_call', params: [] },
      { method: 'eth_chainId', params: [] },
    ]);
    expect(r).toEqual({ ok: true, items: [{ ok: false, kind: 'rpc_error', code: 3, data: '0xdeadbeef' }, { ok: true, result: 'eth_chainId' }] });
  });

  it('never takes an answer to another id as this call', async () => {
    const w = world((b) => Response.json({ jsonrpc: '2.0', id: b.id + 1, result: 'x' }));
    expect(await rpcBatch(w.net, 'https://rpc.test', [{ method: 'eth_chainId', params: [] }])).toEqual({ ok: true, items: [{ ok: false, kind: 'bad_response' }] });
  });
});
