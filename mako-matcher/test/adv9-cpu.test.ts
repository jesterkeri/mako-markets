// Adversary R9: worst-case CPU of one alarm tick at the 1,000-order cap (TICK_WORK bounds order visits, not CPU). The
// repo's own worst book (tick-budget.test.ts) has 3 price levels per option. With 88 levels per option, sizes that grow with
// arrival and every mint's best bids overshooting 100, each candidate fill q also pays the avail build and the subset-sum.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import { MAX_BOOK_ORDERS } from '../src/config';
import type { OrderTuple } from '../src/abi';
import { fresh, type Harness } from './harness';
import { NOW_MS } from './fake';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xb000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

/// 10 options, 100 bids per option at 12 to 99 cents (never below 12, so any 9 options sum to 108 or more: the best
/// mint overshoots 100 and no set is legal, nothing ever crosses), every size different, sizes spread over 10 to 510
/// shares so most candidate fills are legal for most takers.
async function heavyBook(n: number) {
  h.w.markets.set('1', { nOptions: 10, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
  await runInDurableObject(h.stub, (_i, state) => {
    setMeta(state.storage.sql, 'n_options', '10');
    setMeta(state.storage.sql, 'log_cursor', '5000');
    for (let i = 0; i < n; i++) {
      const t: OrderTuple = {
        salt: BigInt(i + 1), maker: W(i + 1), marketId: 1n, option: i % 10, isBuy: true, price: 12 + (Math.floor(i / 10) % 88),
        size: (10n + BigInt(i)) * SH + BigInt(i) * 10_000n, expiration: BigInt(NOW_S + 86_400), nonce: 0n,
      };
      insertOrder(state.storage.sql, t, `0x${t.salt.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
    }
  });
}

describe('worst-case tick CPU at the cap', () => {
  it('a full book with 88 price levels per option stays under the 5 s bound the repo itself asserts for one tick', async () => {
    await heavyBook(MAX_BOOK_ORDERS);
    // the whole rotation (until the book is marked idle), at least one taker per tick
    const idle = async () => (await h.sql<{ k: string }>(`SELECT k FROM meta WHERE k = 'idle_fp'`)).length;
    const ms: number[] = [];
    while ((await idle()) === 0 && ms.length < MAX_BOOK_ORDERS + 1) {
      const t0 = performance.now();
      await h.tick();
      ms.push(performance.now() - t0);
    }
    console.log(`heavy-book ticks (workerd): ${ms.length} ticks, slowest ${Math.max(...ms).toFixed(0)} ms, total ${ms.reduce((a, b) => a + b, 0).toFixed(0)} ms`);
    expect(await idle(), 'the rotation ends').toBe(1);
    expect(h.settled).toHaveLength(0);
    expect(Math.max(...ms), `slowest tick ${Math.max(...ms).toFixed(0)} ms`).toBeLessThan(5_000);
  }, 600_000);
});
