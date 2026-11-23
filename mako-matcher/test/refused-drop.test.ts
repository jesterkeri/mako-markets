// Codex MATCHER R6 F1 (plan 6.2): when an account is refused for the UTC day, its booked orders are dropped as refused
// in EVERY market, not only the one whose settlement failed (that one also gets `refusedMakers` in its outcome). Each
// market's alarm tick reads the settler's daily list and drops that account's orders, whether or not the market has a
// crossing proposal; orders in flight stay until their outcome or release.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder } from '../src/book';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const M = vec('directMakerSell').order.maker; // the account refused in these tests (orders in markets 1 and 2)
const Y = vec('direct3Maker2Sell').order.maker; // another account, never refused
const T = vec('directTakerBuy').order.maker;

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function place(x: Harness, name: string, extra = 500_000_000n) {
  const v = vec(name);
  fund(x.w, v.order, extra);
  return x.place(v);
}
const ordersOf = async (x: Harness, maker: Hex) => (await x.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, maker))[0].n;
const feed = async (x: Harness) => ((await (await x.call('GET', '/book')).json()) as { levels: { option: number; side: string; price: number; orders: number }[] }).levels;
const codes = async (x: Harness) => (await x.alerts()).map((a) => a.code);

describe('Codex MATCHER R6 F1: a refused account loses its booked orders in every market', () => {
  it('two markets, no crossing proposal in either: both drop all of its orders from storage and the feed on the next tick; the new day does not bring them back', async () => {
    const h2 = await fresh('2');
    h2.w.markets.set('2', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
    h2.refused = h.refused; // one settler list for both markets
    h2.refusedEarlier = h.refusedEarlier;
    for (const n of ['directMakerSell', 'mintMakerBuy1', 'mintMakerBuy2']) expect((await place(h, n)).status, n).toBe(200);
    for (const n of ['mmDirectMakerSellB', 'mmMintMakerBuy1B', 'mmMintMakerBuy2B']) expect((await place(h2, n)).status, n).toBe(200);
    expect([await ordersOf(h, M), await ordersOf(h2, M)]).toEqual([2, 2]);
    expect(h.settled.length + h2.settled.length, 'no crossing proposal in either market').toBe(0);

    h.refused.add(M); // excluded by a failed settlement elsewhere: neither market receives an outcome naming it
    await h.tick();
    await h2.tick();
    expect([await ordersOf(h, M), await ordersOf(h2, M)]).toEqual([0, 0]);
    expect([await ordersOf(h, Y), await ordersOf(h2, Y)], "the other account's orders stay").toEqual([1, 1]);
    expect(await feed(h)).toEqual([expect.objectContaining({ option: 2, side: 'buy', price: 30, orders: 1 })]);
    expect(await feed(h2)).toEqual([expect.objectContaining({ option: 2, side: 'buy', price: 30, orders: 1 })]);
    expect(h.settled.length + h2.settled.length).toBe(0);

    // the next UTC day: the list no longer names it, and nothing of it returns
    const nextDay = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
    h.turnDay(nextDay);
    h2.w.nowMs = nextDay;
    await h.tick();
    await h2.tick();
    expect([await ordersOf(h, M), await ordersOf(h2, M)]).toEqual([0, 0]);
    expect((await feed(h)).some((l) => l.option === 0 || l.option === 1)).toBe(false);
  });

  it("its share reservation is freed: the next day its new sell is accepted where it was refused while the old one was booked", async () => {
    expect((await place(h, 'directMakerSell', 0n)).status).toBe(200); // all its option-0 shares reserved
    const second = vec('price40MakerSell'); // same account, same option
    h.w.setPosition(second.order.marketId, second.order.option, second.order.maker, second.order.size);
    expect((await h.place(second)).json).toMatchObject({ ok: false, code: 'insufficient_shares' });
    h.refused.add(M);
    await h.tick();
    expect(await ordersOf(h, M)).toBe(0);
    h.turnDay((Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000);
    expect((await h.place(second)).json).toMatchObject({ ok: true, booked: true });
    // booked after the refused day ended: yesterday's refusal (still read back) does not drop it
    await h.tick();
    expect(await ordersOf(h, M)).toBe(1);
  });

  it('frees book capacity: a full book refuses a new order until the refused account is dropped', async () => {
    await runInDurableObject(h.stub, (_i, state) => {
      for (let i = 0; i < 1_000; i++) {
        const o = { ...vec('directMakerSell').order, salt: BigInt(1_000_000 + i) };
        insertOrder(state.storage.sql, o, `0x${(0xd000_0000 + i).toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, h.w.nowMs);
      }
    });
    expect((await place(h, 'mintMakerBuy2')).status).toBe(409);
    h.refused.add(M);
    await h.tick();
    expect(await ordersOf(h, M)).toBe(0);
    expect((await place(h, 'mintMakerBuy2')).json).toMatchObject({ ok: true, booked: true });
  });

  it('an order in flight is kept while the settler holds it, and dropped on the tick its mark is released', async () => {
    await place(h, 'directMakerSell');
    const lost = h.deps.settle;
    h.deps.settle = async () => {
      throw new Error('answer lost');
    };
    const r = await place(h, 'directTakerBuy');
    h.deps.settle = lost;
    expect(r.json).toMatchObject({ handedOff: 1, handoff: 'unknown' });
    const marked = async () => (await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE in_flight > 0`))[0].n;
    expect(await marked()).toBe(2);

    h.refused.add(M);
    h.held = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    await h.tick();
    h.w.nowMs += 180_000; // past the 2-minute stale-mark age, but the settler says it still holds them
    await h.tick();
    expect(await ordersOf(h, M), 'in flight: kept').toBe(1);
    expect(await marked()).toBe(2);

    h.held = []; // the settler no longer holds them (its answer was lost and it never stored the proposal)
    await h.tick();
    expect(await ordersOf(h, M), 'released, then dropped in the same tick').toBe(0);
    expect(await ordersOf(h, T)).toBe(1);
    expect(await marked()).toBe(0);
  });

  it('an outcome naming the refused account, delivered twice (first answer lost), after the drop: accepted both times, nothing else changes', async () => {
    await place(h, 'directMakerSell');
    await place(h, 'mintMakerBuy1');
    h.settleAccepts = true;
    await place(h, 'directTakerBuy'); // hands off the direct pair; the settler accepts and holds it
    h.held = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    h.refused.add(M);
    await h.tick();
    expect(await ordersOf(h, M), 'the order not in flight is dropped; the one in flight waits for its outcome').toBe(1);
    const out = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1', refusedMakers: [M], release: [vec('directMakerSell').hash, vec('directTakerBuy').hash] };
    for (let i = 0; i < 2; i++) expect((await h.call('POST', '/outcome', { body: out })).status).toBe(200);
    expect(await ordersOf(h, M)).toBe(0);
    expect(await h.sql(`SELECT maker, in_flight FROM orders`)).toEqual([{ maker: T, in_flight: 0 }]);
  });

  it('an unreadable list keeps the orders and alerts; the next readable tick drops them', async () => {
    await place(h, 'directMakerSell');
    h.refused.add(M);
    const inner = h.deps.refusalsSince;
    let reads = 0;
    h.deps.refusalsSince = async (d) => {
      if (++reads === 1) throw new Error('down');
      return inner(d);
    };
    await h.tick();
    expect(await ordersOf(h, M)).toBe(1);
    expect(await codes(h)).toContain('refusal_list_unreadable');
    await h.tick();
    expect(await ordersOf(h, M)).toBe(0);
  });

  it('stale list at intake: the hand-off naming the account is refused (party_refused), and the next tick drops its order rather than only skipping it', async () => {
    h.settlerChecksRefusals = true;
    await place(h, 'directMakerSell'); // M, ask 55, older
    await place(h, 'direct3Maker2Sell'); // Y, ask 55
    const inner = h.deps.refusedList;
    let reads = 0;
    h.deps.refusedList = async () => {
      const snap = await inner();
      if (++reads === 1) h.refused.add(M); // refused just after the intake pass read the list
      return snap;
    };
    const r = await place(h, 'directTakerBuy');
    expect(r.json).toMatchObject({ handedOff: 1, handoff: 'refused' });
    expect(h.refusedHandoffs).toHaveLength(1);
    expect(await ordersOf(h, M), 'still booked after the refusal').toBe(1);
    await h.tick();
    expect(await ordersOf(h, M)).toBe(0);
    expect(h.settled).toHaveLength(1);
    expect(JSON.stringify(h.settled[0]).toLowerCase()).not.toContain(M);
    expect(JSON.stringify(h.settled[0]).toLowerCase()).toContain(Y);
  });
});
