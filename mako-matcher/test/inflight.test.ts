import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import worker from '../src/index';
import type { Env } from '../src/env';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function put(names: string[]) {
  const out: Record<string, unknown>[] = [];
  for (const n of names) {
    const v = vec(n);
    fund(h.w, v.order, 900_000_000n);
    out.push((await h.place(v)).json);
  }
  return out;
}
const flags = async () => (await h.sql<{ hash: string; in_flight: number }>('SELECT hash, in_flight FROM orders ORDER BY seq')).map((r) => r.in_flight);
async function outcome(body: unknown) {
  const res = await h.call('POST', '/outcome', { body });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('in-flight orders (plan 6.2: one match at a time)', () => {
  it('an accepted proposal marks every order in it, in storage, and no other proposal uses them', async () => {
    h.settleAccepts = true;
    await put(['directMakerSell']);
    expect((await put(['directTakerBuy']))[0]).toMatchObject({ handedOff: 1 });
    expect(await flags()).toEqual([1, 1]);
    expect(h.settled).toHaveLength(1);
    await h.tick();
    await h.tick();
    expect(h.settled).toHaveLength(1);
    // a third order that crosses the in-flight sell is not matched against it
    const extra = vec('mintTakerBuy0');
    fund(h.w, extra.order, 900_000_000n);
    h.w.setCash(extra.order.maker, 10n ** 12n);
    expect((await h.place({ ...extra, order: { ...extra.order, option: 0 } })).json).toMatchObject({ ok: true });
    expect(h.settled).toHaveLength(1);
  });

  it('intake still counts an in-flight order\'s shares as reserved', async () => {
    h.settleAccepts = true;
    await put(['directMakerSell', 'directTakerBuy']);
    const again = vec('direct3Maker1Sell'); // eoaMaker1 again, same option: its 100 shares are in flight
    h.w.setPosition(1n, 0, again.order.maker, 100_000_000n);
    expect((await h.place(again)).json).toMatchObject({ code: 'insufficient_shares' });
  });

  it('a proposal the settler refuses, or a settler that fails, leaves nothing marked', async () => {
    await put(['directMakerSell', 'directTakerBuy']);
    expect(await flags()).toEqual([0, 0]);
    h.deps.settle = async () => {
      throw new Error('settler down');
    };
    await h.tick().catch(() => undefined);
    expect(await flags()).toEqual([0, 0]);
  });

  it('the mark is made before the hand-off, so the settler\'s report cannot arrive ahead of it', async () => {
    let seen: number[] = [];
    let calls = 0;
    h.deps.settle = async () => {
      calls++;
      seen = h.state!.storage.sql.exec<{ in_flight: number }>('SELECT in_flight FROM orders ORDER BY seq').toArray().map((r) => r.in_flight);
      return { accepted: true };
    };
    await put(['directMakerSell', 'directTakerBuy']);
    expect(calls).toBe(1);
    expect(seen).toEqual([1, 1]);
  });

  it('a report releases the marks and the orders can match again', async () => {
    h.settleAccepts = true;
    await put(['directMakerSell', 'directTakerBuy']);
    const hashes = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    expect(await outcome({ release: hashes })).toEqual({ status: 200, json: { ok: true } });
    expect(await flags()).toEqual([0, 0]);
    h.settleAccepts = false;
    await h.tick();
    expect(h.settled).toHaveLength(2);
  });
});

describe('what is left after a fill stays booked', () => {
  it('a remainder under 10 shares is neither dropped nor unmatchable', async () => {
    h.settleAccepts = true;
    await put(['directMakerSell', 'directTakerBuy']);
    const sell = vec('directMakerSell');
    const buy = vec('directTakerBuy');
    // 95 of 100 shares settle
    expect(await outcome({ applied: [{ hash: sell.hash, fill: '95000000' }, { hash: buy.hash, fill: '95000000' }], release: [sell.hash, buy.hash] })).toMatchObject({ status: 200 });
    expect((await h.sql<{ filled: string }>('SELECT filled FROM orders WHERE hash = ?', sell.hash))[0].filled).toBe('95000000');
    // the feed still shows the 5 left
    const feed = (await (await h.call('GET', '/book')).json()) as { levels: { size: string }[] };
    expect(feed.levels.map((l) => l.size).sort()).toEqual(['5000000', '5000000']);
    h.settled.length = 0;
    h.settleAccepts = false;
    await h.tick();
    const p = h.settled[0] as { takerFill: string; fills: string[] };
    expect(p.takerFill).toBe('5000000');
    expect(p.fills).toEqual(['5000000']);
  });

  it('a fully filled order leaves the book', async () => {
    await put(['directMakerSell']);
    const sell = vec('directMakerSell');
    await outcome({ applied: [{ hash: sell.hash, fill: '100000000' }], release: [sell.hash] });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 0 }]);
  });

  it('intake still refuses a NEW order under 10 shares', async () => {
    const small = vec('directTakerBuy');
    expect((await h.place({ ...small, order: { ...small.order, size: 5_000_000n } })).json).toMatchObject({ ok: false });
  });
});

describe('the settler\'s report to a market', () => {
  it('drops orders with a reason; a nonce reason also drops the maker\'s older-nonce orders', async () => {
    await put(['directMakerSell', 'directTakerBuy', 'mintMakerBuy1']);
    await outcome({ dropped: [{ hash: vec('directTakerBuy').hash, reason: 'cancelled' }], release: [] });
    expect((await h.sql<{ hash: string }>('SELECT hash FROM orders ORDER BY seq')).map((r) => r.hash)).toEqual([vec('directMakerSell').hash, vec('mintMakerBuy1').hash]);
    // both of eoaMaker1's orders have nonce 0; a nonce error on one drops the other too
    await outcome({ dropped: [{ hash: vec('directMakerSell').hash, reason: 'nonce' }], release: [] });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 0 }]);
  });

  it('removes a refused account\'s orders and, when trading closed, the whole market\'s', async () => {
    await put(['directMakerSell', 'mintMakerBuy2']);
    await outcome({ refusedMakers: [vec('directMakerSell').order.maker], release: [] });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 1 }]);
    await outcome({ closed: true, release: [] });
    expect(await h.sql('SELECT COUNT(*) AS n FROM orders')).toEqual([{ n: 0 }]);
  });

  it('stopMarket halts matching and alerts, until a person restarts it with the secret', async () => {
    await put(['directMakerSell']);
    await outcome({ stopMarket: 'no party could be blamed', release: [] });
    expect((await h.alerts()).map((a) => a.code)).toContain('market_stopped');
    expect((await put(['directTakerBuy']))[0]).toMatchObject({ ok: true, handedOff: 0 });
    h.settled.length = 0;
    await h.tick();
    expect(h.settled).toEqual([]);
    const url = 'https://matcher.test/market/1/restart';
    expect((await worker.fetch(new Request(url, { method: 'POST' }), env as Env)).status).toBe(401);
    expect((await worker.fetch(new Request(url, { method: 'GET' }), env as Env)).status).toBe(405);
    expect((await worker.fetch(new Request(url, { method: 'POST', headers: { 'x-matcher-secret': 'test-cancel-secret' } }), env as Env)).status).toBe(200);
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });

  it('refuses a malformed report whole', async () => {
    for (const b of [null, {}, { release: ['0x12'] }, { release: [], applied: [{ hash: `0x${'a'.repeat(64)}`, fill: '0' }] }, { release: [], dropped: [{ hash: 'x', reason: 'a' }] }, { release: [], refusedMakers: ['0x1'] }]) {
      expect((await outcome(b)).status, JSON.stringify(b)).toBe(400);
    }
    void ('' as Hex);
  });
});
