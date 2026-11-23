import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { parseMarketId } from '../src/routing';
import worker, { secretsEqual, serveBook } from '../src/index';
import type { Env } from '../src/env';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

describe('canonical market ids (plan 6.1, 10.2 Market identity)', () => {
  it('accepts canonical decimals up to 2^256 - 1', () => {
    for (const ok of ['0', '1', '9', '10', '123456789', (2n ** 256n - 1n).toString()]) expect(parseMarketId(ok), ok).toBe(ok);
  });
  it('refuses leading zeros, signs, spaces, other bases and out-of-range values', () => {
    for (const bad of ['01', '00', '+1', '-1', '-0', '1.0', ' 1', '1 ', '0x1', '', '1e3', 'abc', '१', (2n ** 256n).toString(), null, undefined]) {
      expect(parseMarketId(bad as string), String(bad)).toBeNull();
    }
  });
});

describe('the Worker routes only canonical ids', () => {
  const req = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://matcher.test${path}`, init), env as Env);
  it('refuses a non-canonical id on every route before reaching any object', async () => {
    for (const [method, path] of [
      ['POST', '/market/01/orders'],
      ['POST', '/market/-1/orders'],
      ['GET', '/book/01'],
      ['GET', '/book/0x1'],
      ['DELETE', `/market/007/orders/0x${'ab'.repeat(32)}`],
    ] as const) {
      const r = await req(path, { method, body: method === 'POST' ? '{}' : undefined });
      expect(r.status, `${method} ${path}`).toBe(400);
      expect(await r.json()).toEqual({ ok: false, code: 'bad_market_id' });
    }
  });
  it('refuses an oversized order body at the edge, before any object sees it', async () => {
    const r = await req('/market/1/orders', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(9_000) }) });
    expect(r.status).toBe(413);
  });
  it('answers 404 and 405 for what it does not serve', async () => {
    expect((await req('/')).status).toBe(404);
    expect((await req('/nothing')).status).toBe(404);
    expect((await req('/book/1', { method: 'POST', body: '{}' })).status).toBe(405);
    expect((await req('/market/1/orders', { method: 'GET' })).status).toBe(405);
  });
});

describe('market identity inside the object', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await fresh('1');
  });

  it('idFromName gives one id per name, within one namespace', () => {
    expect(env.MARKET.idFromName('1').equals(env.MARKET.idFromName('1'))).toBe(true);
    expect(env.MARKET.idFromName('1').toString()).toBe(env.MARKET.idFromName('1').toString());
    expect(env.MARKET.idFromName('1').equals(env.MARKET.idFromName('2'))).toBe(false);
  });

  it('stores the market id on the first request, only after idFromName(id) equals its own id', async () => {
    expect((await h.call('GET', '/book')).status).toBe(200);
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([{ v: '1' }]);
  });

  it('a first request naming another market stores nothing and is refused and alerted', async () => {
    const res = await h.call('GET', '/book', { marketHeader: '2' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: 'wrong_market_object' });
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([]);
    expect((await h.alerts()).map((a) => a.code)).toEqual(['market_identity_mismatch']);
    // and it can still serve its own market afterwards
    expect((await h.call('GET', '/book')).status).toBe(200);
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([{ v: '1' }]);
  });

  it('a later request naming another market is refused and alerted, and the stored id does not move', async () => {
    await h.call('GET', '/book');
    const res = await h.call('POST', '/orders', { marketHeader: '3', body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, code: 'wrong_market_object' });
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([{ v: '1' }]);
    expect((await h.alerts()).filter((a) => a.code === 'market_identity_mismatch')).toHaveLength(1);
  });

  it('a request with no market id, or a non-canonical one, is refused', async () => {
    for (const hdr of [null, '', '01', '-1', 'x']) {
      const res = await h.call('GET', '/book', { marketHeader: hdr });
      expect(res.status, String(hdr)).toBe(400);
      expect(await res.json()).toEqual({ ok: false, code: 'bad_market_id' });
    }
    expect(await h.sql('SELECT v FROM meta WHERE k = ?', 'market_id')).toEqual([]);
  });

  it('an object named by the Worker for market 5 serves only market 5', async () => {
    const r = await worker.fetch(new Request('https://matcher.test/book/5'), env as Env);
    expect(r.status).toBe(200);
    const stub5 = env.MARKET.get(env.MARKET.idFromName('5'));
    // a request that reaches market 5's object while naming market 6 is a routing bug
    const bad = await stub5.fetch(new Request('https://market/book', { headers: { 'x-market-id': '6' } }));
    expect(bad.status).toBe(400);
  });
});

describe('off-chain cancel (shared secret)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await fresh('1');
  });
  const del = (hash: string, headers: Record<string, string> = {}, e: Env = env as Env) =>
    worker.fetch(new Request(`https://matcher.test/market/1/orders/${hash}`, { method: 'DELETE', headers }), e);

  it('removes the order with the right secret, and only then', async () => {
    const o = vec('directTakerBuy');
    fund(h.w, o.order);
    expect((await h.place(o)).status).toBe(200);
    expect((await del(o.hash)).status).toBe(401);
    expect((await del(o.hash, { 'x-matcher-secret': 'wrong' })).status).toBe(401);
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 1 }]);
    const ok = await del(o.hash, { 'x-matcher-secret': 'test-cancel-secret' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, removed: true, atRelease: false });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 0 }]);
    const again = await del(o.hash, { 'x-matcher-secret': 'test-cancel-secret' });
    expect(await again.json()).toEqual({ ok: true, removed: false, atRelease: false });
  });

  it('with no secret configured no cancel is accepted', async () => {
    const r = await del(`0x${'ab'.repeat(32)}`, { 'x-matcher-secret': 'anything' }, { ...env, CANCEL_SECRET: undefined } as Env);
    expect(r.status).toBe(503);
    const blank = await del(`0x${'ab'.repeat(32)}`, { 'x-matcher-secret': '' }, { ...env, CANCEL_SECRET: '  ' } as Env);
    expect(blank.status).toBe(503);
  });

  it('secretsEqual compares every byte and the length', () => {
    expect(secretsEqual('abc', 'abc')).toBe(true);
    expect(secretsEqual('abc', 'abd')).toBe(false);
    expect(secretsEqual('abc', 'abcd')).toBe(false);
    expect(secretsEqual('', 'a')).toBe(false);
    expect(secretsEqual('', '')).toBe(true);
  });
});

describe('the book feed cache (at most 2 seconds old)', () => {
  function fakeCache() {
    const m = new Map<string, Response>();
    return {
      async match(r: Request) {
        const v = m.get(r.url);
        return v ? v.clone() : undefined;
      },
      async put(r: Request, v: Response) {
        m.set(r.url, v);
      },
    } as unknown as Cache;
  }
  function stubEnv(counter: { n: number }, body = '{"market":"1","asOf":0,"levels":[]}') {
    return {
      MARKET: {
        idFromName: (x: string) => x,
        get: () => ({
          fetch: async () => {
            counter.n++;
            return new Response(body.replace('"asOf":0', `"asOf":${counter.n}`), { status: 200 });
          },
        }),
      },
    } as unknown as Env;
  }

  it('asks the Durable Object at most once per 2 seconds', async () => {
    const counter = { n: 0 };
    const cache = fakeCache();
    let now = 1_000_000;
    const e = stubEnv(counter);
    const get = async () => (await serveBook(e, '1', { cache, now: () => now })).text();
    const a = await get();
    now += 1_999;
    expect(await get()).toBe(a);
    expect(counter.n).toBe(1);
    now += 2; // 2,001 ms since it was stored
    const b = await get();
    expect(b).not.toBe(a);
    expect(counter.n).toBe(2);
  });

  it('a copy dated in the future or with no date is not served', async () => {
    const counter = { n: 0 };
    const cache = fakeCache();
    const e = stubEnv(counter);
    await cache.put(new Request('https://matcher.cache/book/1'), new Response('{"stale":true}', { headers: { 'x-cached-at': '9999999999999' } }));
    const r = await serveBook(e, '1', { cache, now: () => 1_000_000 });
    expect(await r.text()).not.toContain('stale');
    await cache.put(new Request('https://matcher.cache/book/1'), new Response('{"stale":true}'));
    const r2 = await serveBook(e, '1', { cache, now: () => 1_000_000 });
    expect(await r2.text()).not.toContain('stale');
  });

  it('does not cache a failed answer', async () => {
    const cache = fakeCache();
    const e = { MARKET: { idFromName: (x: string) => x, get: () => ({ fetch: async () => new Response('{}', { status: 503 }) }) } } as unknown as Env;
    const r = await serveBook(e, '1', { cache, now: () => 5 });
    expect(r.status).toBe(503);
    expect(await cache.match(new Request('https://matcher.cache/book/1'))).toBeUndefined();
  });
});
