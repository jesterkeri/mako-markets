// Third adversary round on the market object (plan 6.2 "Cancels made on chain": events read every tick, those
// orders dropped). A Durable Object lets requests and alarms interleave at every network await.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import type { OrderTuple } from '../src/abi';
import type { Env } from '../src/env';
import { handleAlarm, handleRequest, type MarketDeps } from '../src/market';
import { orderHash } from '../src/order';
import { fresh, fund, type Harness } from './harness';
import { EXCHANGE, NOW_MS, makeFetch } from './fake';
import { body, signWithKey, V, vec, type VecOrder } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
let salt = 9000n;

async function mk(key: string, over: Partial<OrderTuple> = {}): Promise<VecOrder> {
  const order: OrderTuple = {
    salt: salt++,
    maker: V.keys[key].address.toLowerCase() as Hex,
    marketId: 1n,
    option: 0,
    isBuy: true,
    price: 20,
    size: 10_000_000n,
    expiration: BigInt(NOW_S + 86_400),
    nonce: 0n,
    ...over,
  };
  return { name: 'c', order, signature: await signWithKey(key, order), hash: orderHash(order, { chainId: 10143, exchange: EXCHANGE }) } as VecOrder;
}

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

const ids = async () => (await h.sql<{ hash: string }>('SELECT hash FROM orders ORDER BY seq')).map((r) => r.hash);

/// A fetch that answers the first exchange multicall (the intake's state read) at once, from the world as it is, and
/// then holds the answer until `release()`: the order's state is read, and the reply is still on its way.
function gatedFetch(h: Harness) {
  const inner = makeFetch(h.w);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const hit = new Promise<void>((r) => (reached = r));
  let held = false;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (!held && h.w.calls.at(-1)?.name === 'aggregate3') {
      held = true;
      reached();
      await gate;
    }
    return res;
  }) as typeof fetch;
  return { f, release: () => release(), hit };
}

const req = (o: VecOrder) => new Request('https://market/orders', { method: 'POST', headers: { 'x-market-id': '1' }, body: JSON.stringify(body(o.order, o.signature)) });

describe('adversary 3: two first orders race the log cursor (plan 6.2 Cancels made on chain; intake: "the cursor must start no later than the state this order is judged on")', () => {
  it('a cancel mined after order A\'s state read and before order B started is still read for A', async () => {
    const a = await mk('eoaTaker');
    const b = await mk('eoaMaker1');
    fund(h.w, a.order, 10n ** 9n);
    fund(h.w, b.order, 10n ** 9n);
    const g = gatedFetch(h);
    const gated: MarketDeps = { ...h.deps, fetch: g.f };
    await runInDurableObject(h.stub, async (_i, state) => {
      // A: reads the chain head (5000) and its own state (not cancelled); its reply is held.
      const pa = handleRequest(state, env as Env, req(a), gated);
      await g.hit;
      // The chain moves on: A is cancelled on chain at block 5005, the head is now 5010.
      h.w.orders.set(a.hash, { filled: 0n, cancelled: true });
      h.w.logCancelled(a.hash, a.order.maker, 5005n);
      h.w.block = 5010n;
      // B arrives, reads head 5010 for its cursor, and is booked first.
      expect((await handleRequest(state, env as Env, req(b), h.deps)).status).toBe(200);
      g.release();
      expect((await pa).status).toBe(200);
    });
    expect(await ids()).toContain(a.hash);
    await h.tick();
    // The Worker reads the cancel every tick: A is gone.
    expect(await ids()).not.toContain(a.hash);
  });
});

describe('adversary 3: an alarm that empties the book while an order is being taken in (same invariant)', () => {
  it('an order booked while the alarm dropped the cursor still has its cancels read', async () => {
    // X rests with the cursor set; Y's intake starts (cursor present, so it plans no new one) and its reply is held.
    const x = await mk('eoaTaker');
    const y = await mk('eoaMaker1');
    fund(h.w, x.order, 10n ** 9n);
    fund(h.w, y.order, 10n ** 9n);
    expect((await h.place(x)).status).toBe(200);
    const g = gatedFetch(h);
    const gated: MarketDeps = { ...h.deps, fetch: g.f };
    await runInDurableObject(h.stub, async (_i, state) => {
      const py = handleRequest(state, env as Env, req(y), gated);
      await g.hit;
      // X is cancelled on chain; the alarm reads it, finds the book empty and drops the cursor.
      h.w.logCancelled(x.hash, x.order.maker, 5003n);
      h.w.block = 5010n;
      await state.storage.deleteAlarm();
      await handleAlarm(state, env as Env, h.deps);
      // Y was judged on a state read before this block; it is now booked.
      h.w.orders.set(y.hash, { filled: 0n, cancelled: true });
      h.w.logCancelled(y.hash, y.order.maker, 5008n);
      h.w.block = 5020n;
      g.release();
      expect((await py).status).toBe(200);
    });
    expect(await ids()).toEqual([y.hash]);
    await h.tick();
    expect(await ids()).toEqual([]);
  });
});

describe('adversary 3: the market object is replaced between marking a proposal in flight and the settler hearing of it (brief "In-flight orders": in flight only once the settler accepted; stored so a restart keeps it)', () => {
  it('orders marked for a hand-off that never reached the settler are matched again, not held in flight for good', async () => {
    const maker = vec('directMakerSell');
    const taker = vec('directTakerBuy');
    fund(h.w, maker.order, 900_000_000n);
    fund(h.w, taker.order, 900_000_000n);
    expect((await h.place(maker)).status).toBe(200);
    // The settler is reached, but this object dies in that await: the hand-off never leaves it.
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    const real = h.deps.settle;
    h.deps.settle = () => {
      reached();
      return new Promise(() => undefined);
    };
    await runInDurableObject(h.stub, async (_i, state) => {
      void handleRequest(state, env as Env, req(taker), h.deps);
      await hit;
    });
    expect((await h.sql<{ in_flight: number }>('SELECT in_flight FROM orders ORDER BY seq')).map((r) => r.in_flight > 0)).toEqual([true, true]); // a mark now holds the time it was set
    // A new object on the same storage. The settler holds nothing (it never heard of the proposal) and reports nothing.
    h.deps.settle = real;
    h.settleAccepts = true;
    h.settled.length = 0;
    for (let i = 0; i < 20; i++) {
      h.w.nowMs += 30 * 60 * 1000; // 10 hours in all, inside the orders' lifetime
      await h.tick();
    }
    expect(h.settled.length, 'no tick ever proposed the crossed pair again').toBeGreaterThan(0);
  });
});
