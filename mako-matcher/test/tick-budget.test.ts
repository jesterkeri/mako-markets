// Codex MATCHER_SLICE2 R3 F2: every alarm tick searched with every booked order as a taker over the whole book, and
// a market's book had no size limit, so the work per tick had no bound. Now: at most MAX_BOOK_ORDERS (1,000) resting
// orders per market (intake refuses more), at most TICK_WORK order visits per tick from a rotating cursor, and an idle
// book (a whole rotation found nothing and nothing changed) is not searched again until it changes, the UTC day turns
// or IDLE_RECHECK_MS passes. These run in workerd (the real Durable Object) with a full worst-case book.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import { IDLE_RECHECK_MS, MAX_BOOK_ORDERS, TICK_WORK } from '../src/config';
import { orderHash } from '../src/order';
import type { OrderTuple } from '../src/abi';
import { fresh, fund, type Harness } from './harness';
import { EXCHANGE, NOW_MS } from './fake';
import { V, signWithKey } from './vectors';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xb000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
let seqSalt = 1n;
beforeEach(async () => {
  h = await fresh('1');
  seqSalt = 1n;
});

/// Books orders directly (no signature check: matching never reads one; intake is tested on its own below).
async function book(orders: Partial<OrderTuple>[], nOptions: number) {
  h.w.markets.set('1', { nOptions, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
  await runInDurableObject(h.stub, (_i, state) => {
    setMeta(state.storage.sql, 'n_options', String(nOptions));
    setMeta(state.storage.sql, 'log_cursor', '5000');
    for (const o of orders) {
      const t: OrderTuple = {
        salt: seqSalt++, maker: W(Number(seqSalt)), marketId: 1n, option: 0, isBuy: true, price: 5, size: 10n * SH,
        expiration: BigInt(NOW_S + 86_400), nonce: 0n, ...o,
      };
      insertOrder(state.storage.sql, t, `0x${t.salt.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
    }
  });
}

/// The worst case found so far (adversary R8's slow book): 10 options, every order a bid at 1 to 3 cents (nothing
/// crosses), each with a DIFFERENT size (10 shares + i lots), so each search has about 2n candidate fills q and runs
/// its set search at every one of them, and finds nothing.
function deadBook(n: number): Partial<OrderTuple>[] {
  return Array.from({ length: n }, (_, i) => ({ option: i % 10, isBuy: true, price: 1 + (i % 3), size: 10n * SH + BigInt(i + Number(seqSalt)) * 10_000n }));
}

async function timedTick(): Promise<number> {
  const t0 = performance.now();
  await h.tick();
  return performance.now() - t0;
}

describe('a market-wide cap at intake', () => {
  it(`a market holding ${MAX_BOOK_ORDERS} live orders refuses the next (409 book_full); an expired order does not count`, async () => {
    await book(deadBook(MAX_BOOK_ORDERS - 1), 3);
    await book([{ expiration: BigInt(NOW_S - 1) }], 3); // expired: not live
    const order: OrderTuple = {
      salt: 900_001n, maker: V.keys.eoaTaker.address.toLowerCase() as Hex, marketId: 1n, option: 0, isBuy: true, price: 5,
      size: 10n * SH, expiration: BigInt(NOW_S + 86_400), nonce: 0n,
    };
    const sign = async (o: OrderTuple) => ({ order: o, signature: await signWithKey('eoaTaker', o), hash: orderHash(o, { chainId: 10143, exchange: EXCHANGE }) });
    const first = await sign(order);
    fund(h.w, first.order, 10n ** 9n);
    expect((await h.placeRaw(first)).status).toBe(200); // the 1,000th live order
    const next = await sign({ ...order, salt: 900_002n });
    const r = await h.placeRaw(next);
    expect([r.status, r.json.code]).toEqual([409, 'book_full']);
  });
});

describe('the alarm tick has a bound and a full pass rotates', () => {
  it('worst case: a full 1,000-order, 10-option book that never crosses; every tick stays bounded, the rotation ends, then idle ticks skip', async () => {
    await book(deadBook(MAX_BOOK_ORDERS), 10);
    const per = Math.floor(TICK_WORK / MAX_BOOK_ORDERS);
    const ticks = Math.ceil(MAX_BOOK_ORDERS / per);
    const ms: number[] = [];
    for (let i = 0; i < ticks; i++) ms.push(await timedTick());
    const worst = Math.max(...ms);
    console.log(`full-book ticks (workerd): ${ms.map((x) => x.toFixed(0)).join(', ')} ms; ${per} takers per tick`);
    expect(worst, `slowest tick ${worst.toFixed(0)} ms`).toBeLessThan(5_000);
    expect(h.settled).toHaveLength(0);
    const idle = (await h.sql<{ k: string }>(`SELECT k FROM meta WHERE k = 'idle_fp'`)).length;
    expect(idle, 'a whole clean rotation marks the book idle').toBe(1);
    const skipped = await timedTick();
    console.log(`idle tick: ${skipped.toFixed(0)} ms`);
    expect(skipped).toBeLessThan(worst);
  });

  it('no fixed prefix: the only crossing pair is the OLDEST, and a new order lands every tick; the pair is still handed over within one rotation', async () => {
    // the pair first (oldest seqs): a resting ask at 40, then a bid at 60 on option 0 (as if its match had been
    // blocked when it arrived), then 998 orders that never cross
    await book([{ option: 0, isBuy: false, price: 40, size: 20n * SH }, { option: 0, isBuy: true, price: 60, size: 20n * SH }], 10);
    await book(deadBook(MAX_BOOK_ORDERS - 2), 10);
    const per = Math.floor(TICK_WORK / MAX_BOOK_ORDERS);
    const limit = Math.ceil(MAX_BOOK_ORDERS / per) + 2;
    let handed = -1;
    for (let i = 0; i < limit && handed < 0; i++) {
      await h.tick();
      if (h.settled.length > 0) handed = i;
      // the book changes every tick (an order out, a new one in), so no rotation is ever clean
      await h.sql(`DELETE FROM orders WHERE seq = (SELECT MAX(seq) FROM orders)`);
      await book(deadBook(1), 10);
    }
    expect(handed, `handed over by tick ${limit}`).toBeGreaterThanOrEqual(0);
  });
});

describe('idle skipping never hides a change', () => {
  async function idleBook() {
    await book(deadBook(50), 10);
    await h.tick(); // 50 orders fit one tick: one clean rotation
    expect((await h.sql(`SELECT k FROM meta WHERE k = 'idle_fp'`)).length).toBe(1);
  }
  const searches = () => h.w.calls.length;

  it('an unchanged book is not searched again (no chain reads beyond the cancel scan)', async () => {
    await idleBook();
    const r = await runInDurableObject(h.stub, async (_i, state) => {
      const { spreadPass } = await import('../src/market');
      const { readConfig } = await import('../src/config');
      const { makeAlert } = await import('../src/alerts');
      return spreadPass(state, readConfig((await import('cloudflare:workers')).env as never), h.deps, makeAlert(state.storage.sql, h.deps.now, h.deps.log));
    });
    expect(r).toEqual({ handedOff: 0, tried: 0, skipped: true });
  });

  it('a new crossing order on an idle book is matched (the book changed)', async () => {
    await idleBook();
    h.settled.length = 0;
    await book([{ option: 3, isBuy: false, price: 40, size: 20n * SH }, { option: 3, isBuy: true, price: 60, size: 20n * SH }], 10);
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });

  it(`an idle book is searched again after ${IDLE_RECHECK_MS / 60_000} minutes, and when the UTC day turns`, async () => {
    await idleBook();
    void searches;
    const tried = async () =>
      runInDurableObject(h.stub, async (_i, state) => {
        const { spreadPass } = await import('../src/market');
        const { readConfig } = await import('../src/config');
        const { makeAlert } = await import('../src/alerts');
        return (await spreadPass(state, readConfig((await import('cloudflare:workers')).env as never), h.deps, makeAlert(state.storage.sql, h.deps.now, h.deps.log))).skipped;
      });
    h.w.nowMs += IDLE_RECHECK_MS - 1_000;
    expect(await tried()).toBe(true);
    h.w.nowMs += 2_000;
    expect(await tried()).toBe(false); // searched again (and idle again after this clean rotation)
    h.w.nowMs = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000 + 1_000; // next UTC day, within the recheck window
    expect(await tried()).toBe(false);
  });
});
