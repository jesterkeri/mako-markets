import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { LOG_CHUNK_BLOCKS, MAX_LOG_CHUNKS_PER_TICK, TICK_MS } from '../src/config';
import { orderHash } from '../src/order';
import type { OrderTuple } from '../src/abi';
import { fresh, fund, type Harness } from './harness';
import { EXCHANGE, NOW_MS } from './fake';
import { V, signWithKey, type VecOrder } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
let salt = 5000n;

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
  return { name: 'c', order, signature: await signWithKey(key, order), hash: orderHash(order, { chainId: 10143, exchange: EXCHANGE }) };
}

async function ids(h: Harness) {
  return (await h.sql<{ hash: string }>('SELECT hash FROM orders ORDER BY seq')).map((r) => r.hash);
}
async function alarm(h: Harness) {
  return runInDurableObject(h.stub, (_i, state) => state.storage.getAlarm());
}
async function cursor(h: Harness) {
  return (await h.sql<{ v: string }>('SELECT v FROM meta WHERE k = ?', 'log_cursor'))[0]?.v ?? null;
}

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

describe('cancels made on chain (plan 6.2)', () => {
  it('an OrderCancelled event removes that order and no other', async () => {
    const a = await mk('eoaTaker');
    const b = await mk('eoaTaker');
    fund(h.w, a.order, 10n ** 9n);
    expect((await h.place(a)).status).toBe(200);
    expect((await h.place(b)).status).toBe(200);
    expect(await cursor(h)).toBe('5000');
    h.w.block = 5010n;
    h.w.logCancelled(a.hash, a.order.maker, 5005n);
    await h.tick();
    expect(await ids(h)).toEqual([b.hash]);
    expect(await cursor(h)).toBe('5010');
    expect(h.w.calls.some((c) => c.batch)).toBe(false);
  });

  it('a nonce bump drops every order of that maker BELOW the new nonce, and no other maker\'s', async () => {
    const old1 = await mk('eoaTaker');
    const old2 = await mk('eoaTaker');
    const stranger = await mk('eoaMaker1');
    for (const o of [old1, old2, stranger]) fund(h.w, o.order, 10n ** 9n);
    for (const o of [old1, old2, stranger]) expect((await h.place(o)).status).toBe(200);
    // the maker bumps its nonce to 1, then places a nonce-1 order
    h.w.nonces.set(old1.order.maker, 1n);
    const fresh1 = await mk('eoaTaker', { nonce: 1n });
    expect((await h.place(fresh1)).status).toBe(200);
    h.w.block = 5020n;
    h.w.logNonce(old1.order.maker, 1n, 5004n);
    await h.tick();
    expect(await ids(h)).toEqual([stranger.hash, fresh1.hash]);
  });

  it('events before the cursor are not read, and chunks never exceed the RPC cap', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.logCancelled(a.hash, a.order.maker, 4_990n); // before the cursor (5000): already in the state read at intake
    h.w.block = 5000n + BigInt(LOG_CHUNK_BLOCKS) * 2n + 50n;
    await h.tick();
    expect(await ids(h)).toEqual([a.hash]);
    expect(await cursor(h)).toBe(h.w.block.toString());
    const logCalls = h.w.calls.filter((c) => c.method === 'eth_getLogs').length;
    expect(logCalls).toBe(3);
  });

  it('a late event in the third chunk is applied', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.block = 5000n + BigInt(LOG_CHUNK_BLOCKS) * 2n + 50n;
    h.w.logCancelled(a.hash, a.order.maker, h.w.block - 1n);
    await h.tick();
    expect(await ids(h)).toEqual([]);
  });

  it('reads at most the per-tick chunk limit and finishes on the next tick', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.block = 5000n + BigInt(LOG_CHUNK_BLOCKS * (MAX_LOG_CHUNKS_PER_TICK + 2));
    await h.tick();
    expect(await cursor(h)).toBe((5000n + BigInt(LOG_CHUNK_BLOCKS * MAX_LOG_CHUNKS_PER_TICK)).toString());
    await h.tick();
    expect(await cursor(h)).toBe(h.w.block.toString());
  });

  it('a failed log read keeps the cursor and the order, and alerts', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.block = 5050n;
    h.w.logCancelled(a.hash, a.order.maker, 5010n);
    h.w.fail = (m) => (m === 'eth_getLogs' ? 'down' : null);
    await h.tick();
    expect(await ids(h)).toEqual([a.hash]);
    expect(await cursor(h)).toBe('5000');
    expect((await h.alerts()).map((x) => x.code)).toContain('log_read_failed');
    h.w.fail = null;
    await h.tick();
    expect(await ids(h)).toEqual([]);
  });

  it('a log that does not decode stops the read: the cursor never moves past an event it did not understand', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.block = 5050n;
    h.w.logs.push({ block: 5020n, topics: [h.w.logs[0]?.topics[0] ?? ('0x' + '11'.repeat(32)) as Hex], data: '0x' });
    // an event with the Cancelled topic but the wrong shape
    const real = await mk('eoaTaker');
    h.w.logCancelled(real.hash, real.order.maker, 5030n);
    h.w.logs[h.w.logs.length - 1].data = '0x1234';
    h.w.logs[h.w.logs.length - 1].topics = h.w.logs[h.w.logs.length - 1].topics.slice(0, 1);
    await h.tick();
    expect(await cursor(h)).toBe('5000');
    expect(await ids(h)).toEqual([a.hash]);
    expect((await h.alerts()).map((x) => x.code)).toContain('log_read_failed');
  });

  it('none of this counts against the maker: nothing is handed to the settler or written about the maker', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.block = 5010n;
    h.w.logCancelled(a.hash, a.order.maker, 5005n);
    await h.tick();
    expect(h.settled).toEqual([]);
    expect((await h.alerts()).filter((x) => x.detail.includes(a.order.maker))).toEqual([]);
  });
});

describe('expiry and the alarm', () => {
  it('an order that has expired is dropped, and an empty book stops the alarm and the cursor', async () => {
    const a = await mk('eoaTaker', { expiration: BigInt(NOW_S + 5) });
    fund(h.w, a.order);
    await h.place(a);
    expect(await alarm(h)).toBe(NOW_MS + TICK_MS);
    h.w.nowMs += 6_000;
    await h.tick();
    expect(await ids(h)).toEqual([]);
    expect(await cursor(h)).toBeNull();
    expect(await alarm(h)).toBeNull();
  });

  it('an order expiring exactly now is dropped; one expiring next second is kept', async () => {
    const gone = await mk('eoaTaker', { expiration: BigInt(NOW_S + 5) });
    const kept = await mk('eoaTaker', { expiration: BigInt(NOW_S + 6) });
    fund(h.w, gone.order, 10n ** 9n);
    await h.place(gone);
    await h.place(kept);
    h.w.nowMs = (NOW_S + 5) * 1000;
    await h.tick();
    expect(await ids(h)).toEqual([kept.hash]);
  });

  it('with orders left the alarm wakes again after one tick interval', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    h.w.nowMs += 3_000;
    await h.tick();
    expect(await alarm(h)).toBe(h.w.nowMs + TICK_MS);
  });

  it('a tick with the configuration gone reschedules and alerts instead of dropping anything', async () => {
    const a = await mk('eoaTaker');
    fund(h.w, a.order);
    await h.place(a);
    await h.tick({ EXCHANGE_ADDRESS: undefined });
    expect(await ids(h)).toEqual([a.hash]);
    expect((await h.alerts()).map((x) => x.code)).toContain('not_configured');
    expect(await alarm(h)).not.toBeNull();
  });
});
