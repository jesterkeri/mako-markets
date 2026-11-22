// Fourth adversary round, market object. A Durable Object lets a request and the alarm interleave at every network await.
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
import { body, signWithKey, V, type VecOrder } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
let salt = 19000n;

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
const req = (o: VecOrder) => new Request('https://market/orders', { method: 'POST', headers: { 'x-market-id': '1' }, body: JSON.stringify(body(o.order, o.signature)) });

/// A fetch that answers the first call whose recorded name or method matches at once, then holds the answer.
function gate(h: Harness, match: (c: { method?: string; name?: string }) => boolean) {
  const inner = makeFetch(h.w);
  let release!: () => void;
  const g = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const hit = new Promise<void>((r) => (reached = r));
  let held = false;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const last = h.w.calls.at(-1);
    if (!held && last && match(last)) {
      held = true;
      reached();
      await g;
    }
    return res;
  }) as typeof fetch;
  return { f, release: () => release(), hit };
}

describe('adversary 4: an alarm reading the logs while an order is booked (plan 6.2 Cancels made on chain: read every tick; intake: cursor no later than the state the order is judged on)', () => {
  it('an in-flight log read that finishes after intake booked the order does not skip that order\'s cancel', async () => {
    const x = await mk('eoaTaker');
    const y = await mk('eoaMaker1');
    fund(h.w, x.order, 10n ** 9n);
    fund(h.w, y.order, 10n ** 9n);
    expect((await h.place(x)).status).toBe(200); // cursor = 5000
    const gy = gate(h, (c) => c.name === 'aggregate3');
    const gl = gate(h, (c) => c.method === 'eth_getLogs');
    await runInDurableObject(h.stub, async (_i, state) => {
      // Y: head 5000 read, its own state read (not cancelled) answered, reply held.
      const py = handleRequest(state, env as Env, req(y), { ...h.deps, fetch: gy.f } as MarketDeps);
      await gy.hit;
      // Y is cancelled on chain at block 5005 (after the state read). A tick reads blocks 5001..5010: Y is not booked yet.
      h.w.orders.set(y.hash, { filled: 0n, cancelled: true });
      h.w.logCancelled(y.hash, y.order.maker, 5005n);
      h.w.block = 5010n;
      await state.storage.deleteAlarm();
      await handleAlarm(state, env as Env, h.deps);
      // The next tick starts reading 5011..5020 (cursor was 5010), and its reply is held.
      h.w.block = 5020n;
      await state.storage.deleteAlarm();
      const pal = handleAlarm(state, env as Env, { ...h.deps, fetch: gl.f } as MarketDeps);
      await gl.hit;
      // Y's reply arrives now: Y is booked, the cursor is moved back to 5000, the log read is still outstanding.
      gy.release();
      expect((await py).status).toBe(200);
      gl.release();
      await pal;
    });
    expect(await ids()).toContain(y.hash);
    h.w.block = 5020n;
    await h.tick();
    await h.tick();
    expect(await ids(), 'Y was cancelled on chain at 5005 and no tick ever read that block for Y').not.toContain(y.hash);
  });
});
