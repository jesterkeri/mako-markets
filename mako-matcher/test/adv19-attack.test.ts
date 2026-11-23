// Adversary R19 on 1945fb2 (failed there; fixed: one watch token per intake request). Req 1: POST /orders answers
// truthfully when two requests for the SAME order hash are in flight (a client retry). The watch map was keyed by hash,
// so the second request overwrote the first's entry and the first request's `finally` deleted it from under the second.
// The second test, added with the fix, has the first request finish BEFORE the drop, so its cleanup must not take the
// retry's token with it.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { handleRequest, type MarketDeps } from '../src/market';
import { utcDay } from '../src/settle';
import { fresh, fund, type Harness } from './harness';
import { body, vec } from './vectors';

const M = vec('directMakerSell').order.maker.toLowerCase() as Hex;

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function place(name: string) {
  const v = vec(name);
  fund(h.w, v.order, 500_000_000n);
  return h.place(v);
}
const ordersOf = async (maker: Hex) => (await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, maker))[0].n;
const nextDay = () => (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('adversary R19: two requests for the same order hash', () => {
  it('a retry in flight while the first request finishes: the retry is still told account_refused when its order is dropped', async () => {
    const D = utcDay(nextDay() - 1);
    h.w.nowMs = nextDay() - 60_000;
    await place('directTakerBuy'); // crossing side, another account
    h.refusedEarlier.push({ maker: M, day: D });
    h.w.nowMs = nextDay() + 10_000; // inside the slack: an order booked now is covered by the refusal for D

    const v = vec('directMakerSell');
    fund(h.w, v.order, 500_000_000n);

    const stored1 = () => h.state!.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, M).one().n > 0;
    const innerFetch = h.deps.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bBlocked = false;
    // B (the retry) runs on its own deps so its chain reads can be held after it has stored the order
    const depsB: MarketDeps = {
      ...h.deps,
      fetch: async (i, x) => {
        const stored = stored1();
        if (stored && !bBlocked) {
          bBlocked = true;
          await gate;
        }
        return innerFetch(i, x);
      },
    };
    let bRes: Promise<{ status: number; text: string }> | null = null;
    let started = false;
    h.deps.fetch = async (i, x) => {
      // the first chain read of A's pass, after A stored its order: the order is gone (a cancel seen meanwhile) and the
      // client's retry of the same signed order reaches the object
      if (!started && stored1()) {
        started = true;
        h.state!.storage.sql.exec(`DELETE FROM orders WHERE maker = ?`, M);
        const req = new Request('https://market/orders', { method: 'POST', headers: { 'x-market-id': '1' }, body: JSON.stringify(body(v.order, v.signature)) });
        bRes = handleRequest(h.state!, env as never, req, depsB).then(async (r) => ({ status: r.status, text: await r.text() }));
        for (let n = 0; n < 200 && !bBlocked; n++) await tick();
      }
      return innerFetch(i, x);
    };
    const a = await h.place(v);
    h.deps.fetch = innerFetch;
    expect(started, 'the retry was started inside the first request').toBe(true);
    expect(bBlocked, 'the retry stored the order and is awaiting its pass').toBe(true);
    // the first request's pass read the refusal and dropped the (retry's) order
    expect(await ordersOf(M), 'the order is not in storage').toBe(0);
    void a;
    release();
    const b = await bRes!;
    const bj = JSON.parse(b.text) as Record<string, unknown>;
    expect(bj, 'the retry must match storage: its order was dropped as refused').toMatchObject({ ok: false, code: 'account_refused' });
    expect(b.status).toBe(400);
  });

  it('the first request finishes while the retry is in flight; a refusal then drops the retry\'s order: the retry is told account_refused', async () => {
    const D = utcDay(nextDay() - 1);
    h.w.nowMs = nextDay() - 60_000;
    await place('directTakerBuy');
    h.w.nowMs = nextDay() + 10_000; // inside the slack of a refusal for D, written later

    const v = vec('directMakerSell');
    fund(h.w, v.order, 500_000_000n);
    const stored1 = () => h.state!.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, M).one().n > 0;
    const innerFetch = h.deps.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bBlocked = false;
    const depsB: MarketDeps = {
      ...h.deps,
      fetch: async (i, x) => {
        if (stored1() && !bBlocked) {
          bBlocked = true;
          await gate;
        }
        return innerFetch(i, x);
      },
    };
    let bRes: Promise<{ status: number; text: string }> | null = null;
    let started = false;
    h.deps.fetch = async (i, x) => {
      if (!started && stored1()) {
        started = true;
        h.state!.storage.sql.exec(`DELETE FROM orders WHERE maker = ?`, M); // a cancel seen meanwhile
        const req = new Request('https://market/orders', { method: 'POST', headers: { 'x-market-id': '1' }, body: JSON.stringify(body(v.order, v.signature)) });
        bRes = handleRequest(h.state!, env as never, req, depsB).then(async (r) => ({ status: r.status, text: await r.text() }));
        for (let n = 0; n < 200 && !bBlocked; n++) await tick();
      }
      return innerFetch(i, x);
    };
    await h.place(v); // the first request answers and runs its cleanup
    h.deps.fetch = innerFetch;
    expect(bBlocked, 'the retry stored the order and is awaiting its pass').toBe(true);
    h.refusedEarlier.push({ maker: M, day: D }); // now excluded for D, which covers the retry's booking
    release();
    const b = await bRes!;
    expect(await ordersOf(M), 'dropped by the retry\'s own pass').toBe(0);
    expect(b.status).toBe(400);
    expect(JSON.parse(b.text)).toMatchObject({ ok: false, code: 'account_refused' });
  });
});
