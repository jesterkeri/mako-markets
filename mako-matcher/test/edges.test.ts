// Edges that the other files do not reach: the real Worker route into the real object, the real Cache API, the
// real settler hand-off dependencies when the settler misbehaves, and a revert from the exchange's own view.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { encodeErrorResult } from 'viem';
import worker from '../src/index';
import { EXCHANGE_ABI } from '../src/abi';
import { realDeps } from '../src/market';
import type { Env } from '../src/env';
import { fresh, fund, type Harness } from './harness';
import { V, body, vec } from './vectors';

describe('the real Worker route into the real object', () => {
  it('an order for market 2 posted to /market/1/orders is refused wrong_market by the real object, with no network', async () => {
    const wrong = vec('mmDirectMakerSellB');
    const res = await worker.fetch(
      new Request('https://matcher.test/market/1/orders', { method: 'POST', body: JSON.stringify(body(wrong.order, wrong.signature)) }),
      env as Env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: 'wrong_market' });
  });

  it('serves GET /book/:id from the real Cache API: a second call within 2 seconds is the cached copy', async () => {
    const get = async () => (await worker.fetch(new Request('https://matcher.test/book/41'), env as Env)).json() as Promise<{ asOf: number }>;
    const a = await get();
    await new Promise((r) => setTimeout(r, 30));
    const b = await get();
    expect(b.asOf).toBe(a.asOf);
    await new Promise((r) => setTimeout(r, 2_100));
    const c = await get();
    expect(c.asOf).toBeGreaterThan(a.asOf);
  });
});

describe('object edges', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await fresh('1');
  });

  it('an object whose stored market id disagrees with its own identity refuses everything and alerts', async () => {
    await h.call('GET', '/book');
    await h.sql("UPDATE meta SET v = '9' WHERE k = 'market_id'");
    const res = await h.call('GET', '/book');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: 'wrong_market_object' });
    expect((await h.alerts()).map((a) => a.code)).toContain('market_identity_mismatch');
  });

  it('answers 503 not_configured to the feed too when there is no exchange address, and 404 to unknown routes', async () => {
    const res = await h.call('GET', '/book', { env: { EXCHANGE_ADDRESS: undefined } });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'not_configured' });
    const bad = await h.call('PUT', '/orders');
    expect(bad.status).toBe(404);
    expect(((await h.call('GET', '/orders/0x12')).status)).toBe(404);
  });

  it('refuses a configuration with a non-HTTPS RPC URL, a bad exchange address or a bad chain id', async () => {
    for (const over of [{ PRIMARY_RPC_URL: 'http://rpc.test/' }, { EXCHANGE_ADDRESS: '0x1234' }, { CHAIN_ID: '10143.5' }, { CHAIN_ID: '0' }, { PRIMARY_RPC_URL: 'not a url' }]) {
      const res = await h.call('GET', '/book', { env: over });
      expect(res.status, JSON.stringify(over)).toBe(503);
    }
  });

  it('the primary RPC URL is used when set, the public one otherwise', async () => {
    const urls: string[] = [];
    const real = h.deps.fetch;
    h.deps.fetch = (async (u: RequestInfo | URL, i?: RequestInit) => {
      urls.push(String(u));
      return real(u, i);
    }) as typeof fetch;
    const o = vec('directTakerBuy');
    fund(h.w, o.order);
    await h.place(o);
    expect(new Set(urls)).toEqual(new Set(['https://rpc.test/']));
    urls.length = 0;
    const o2 = vec('mintMakerBuy1');
    fund(h.w, o2.order);
    const res = await h.call('POST', '/orders', { body: body(o2.order, o2.signature), env: { PRIMARY_RPC_URL: undefined } });
    expect(res.status).toBe(200);
    expect(new Set(urls)).toEqual(new Set(['https://testnet-rpc.monad.xyz/']));
  });

  it('a revert from the exchange view other than a length error fails closed with 503 and an alert', async () => {
    h.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
    const s = vec('safeTakerBuy');
    fund(h.w, s.order);
    h.w.revert.isValidOrderSignature = 'InsufficientGas';
    const r = await h.place(s);
    expect(r).toEqual({ status: 503, json: { ok: false, code: 'chain_read_failed' } });
    expect((await h.alerts()).map((a) => a.code)).toContain('signature_view_reverted');
    void encodeErrorResult;
    void EXCHANGE_ABI;
  });
});

describe('the settler dependencies when the settler misbehaves', () => {
  const addr = ('0x' + 'ab'.repeat(20)) as `0x${string}`;
  const withStub = (fetchFn: () => Promise<Response>) =>
    realDeps({ SETTLER: { idFromName: (n: string) => n, get: () => ({ fetch: fetchFn }) } } as unknown as Env);

  it('an unreadable refusal list throws, so intake fails closed', async () => {
    await expect(withStub(async () => new Response('x', { status: 503 })).refusedToday(addr)).rejects.toThrow();
    await expect(withStub(async () => new Response('{"refused":"no"}', { status: 200 })).refusedToday(addr)).rejects.toThrow();
    await expect(withStub(async () => new Response('{"refused":true}', { status: 200 })).refusedToday(addr)).resolves.toBe(true);
  });

  it('a settle answer is the boolean `accepted` the settler wrote; anything else is no answer (throws), never a refusal', async () => {
    expect(await withStub(async () => new Response('{"accepted":true}', { status: 200 })).settle({})).toEqual({ accepted: true });
    expect(await withStub(async () => new Response('{"ok":false,"accepted":false,"error":"busy"}', { status: 503 })).settle({})).toEqual({ accepted: false });
    // the body decides, not the status: a settler that wrote accepted:true took the proposal
    expect(await withStub(async () => new Response('{"accepted":true}', { status: 503 })).settle({})).toEqual({ accepted: true });
    await expect(withStub(async () => new Response('{"accepted":"yes"}', { status: 200 })).settle({})).rejects.toThrow();
    await expect(withStub(async () => new Response('not json', { status: 200 })).settle({})).rejects.toThrow();
    await expect(withStub(async () => new Response('Internal Server Error', { status: 500 })).settle({})).rejects.toThrow();
  });
});
