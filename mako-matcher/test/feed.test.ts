import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { OrderTuple } from '../src/abi';
import { buildFeed } from '../src/feed';
import type { BookOrder } from '../src/book';
import { fresh, fund, type Harness } from './harness';
import { NOW_MS } from './fake';
import { V, signWithKey, vec } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
let salt = 9000n;
async function mk(key: string, over: Partial<OrderTuple>) {
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
  return { name: 'c', order, signature: await signWithKey(key, order), hash: '0x' as Hex };
}

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

describe('GET /book: aggregated price levels, never signatures', () => {
  it('sums orders at one price, orders levels best first, and leaks nothing about who or what was signed', async () => {
    const orders = [
      await mk('eoaTaker', { price: 20, size: 10_000_000n }),
      await mk('eoaMaker1', { price: 20, size: 30_000_000n }),
      await mk('eoaMaker2', { price: 25, size: 10_000_000n }),
      await mk('eoaMaker3', { price: 70, isBuy: false, size: 20_000_000n }),
      await mk('eoaMaker3', { price: 60, isBuy: false, size: 10_000_000n }),
      await mk('eoaMaker3', { price: 22, option: 1, size: 10_000_000n }),
    ];
    for (const o of orders) {
      fund(h.w, o.order, 10n ** 9n);
      expect((await h.place(o)).status, JSON.stringify(o.order.price)).toBe(200);
    }
    const res = await h.call('GET', '/book');
    expect(res.status).toBe(200);
    const text = await res.text();
    const feed = JSON.parse(text) as { market: string; asOf: number; levels: { option: number; side: string; price: number; size: string; orders: number }[] };
    expect(feed.market).toBe('1');
    expect(feed.asOf).toBe(NOW_MS);
    expect(feed.levels).toEqual([
      { option: 0, side: 'buy', price: 25, size: '10000000', orders: 1 },
      { option: 0, side: 'buy', price: 20, size: '40000000', orders: 2 },
      { option: 0, side: 'sell', price: 60, size: '10000000', orders: 1 },
      { option: 0, side: 'sell', price: 70, size: '20000000', orders: 1 },
      { option: 1, side: 'buy', price: 22, size: '10000000', orders: 1 },
    ]);
    // no signature, hash, maker, salt or nonce anywhere in the answer
    for (const o of orders) {
      expect(text).not.toContain(o.signature.slice(2, 30));
      expect(text).not.toContain(o.order.maker.slice(2));
    }
    expect(text).not.toMatch(/0x[0-9a-f]{8}/i);
    expect(Object.keys(feed).sort()).toEqual(['asOf', 'levels', 'market']);
  });

  it('shows what is left of a part-filled order and hides expired and empty ones', () => {
    const mkRow = (over: Partial<BookOrder>): BookOrder =>
      ({ seq: 1, hash: '0x01', maker: '0x02', salt: 1n, marketId: 1n, option: 0, isBuy: true, price: 50, size: 100n, expiration: 2_000_000_000n, nonce: 0n, signature: '0x11', fee: 0n, filled: 0n, remaining: 100n, createdAt: 0, ...over }) as BookOrder;
    const feed = buildFeed(
      1n,
      [mkRow({ remaining: 40n, filled: 60n }), mkRow({ expiration: BigInt(NOW_S) }), mkRow({ remaining: 0n, filled: 100n, price: 51 })],
      NOW_MS,
    );
    expect(feed.levels).toEqual([{ option: 0, side: 'buy', price: 50, size: '40', orders: 1 }]);
  });

  it('an empty book is an empty feed', async () => {
    const res = await h.call('GET', '/book');
    expect(await res.json()).toEqual({ market: '1', asOf: NOW_MS, levels: [] });
  });

  it('is not changed by a vector order that was refused', async () => {
    const v = vec('directTakerBuy'); // unfunded
    expect((await h.place(v)).status).toBe(400);
    expect(((await (await h.call('GET', '/book')).json()) as { levels: unknown[] }).levels).toEqual([]);
  });
});
