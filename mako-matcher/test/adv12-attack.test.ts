// Adversary R12 on f5b64d0 (Codex MATCHER R4 F1 fix): attacks on the whole-book party check. Chunk boundaries of the
// role multicalls, a failure part way through the reads, the UTC day turn right after a book went idle, and the
// subrequest total of the worst alarm tick. (Intake's own pass is covered by handoff.test.ts, which books through it.)
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, markInFlight, setMeta } from '../src/book';
import { MAX_BOOK_ORDERS, ROLE_CHUNK, TICK_MS } from '../src/config';
import type { OrderTuple } from '../src/abi';
import { fresh, type Harness } from './harness';
import { NOW_MS } from './fake';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xd000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
let salt = 1n;
beforeEach(async () => {
  h = await fresh('1');
  salt = 1n;
});

async function book(orders: Partial<OrderTuple>[], opts: { cursor?: string } = {}): Promise<Hex[]> {
  const out: Hex[] = [];
  h.w.markets.set('1', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
  await runInDurableObject(h.stub, (_i, state) => {
    setMeta(state.storage.sql, 'n_options', '3');
    setMeta(state.storage.sql, 'log_cursor', opts.cursor ?? '5000');
    for (const o of orders) {
      const t: OrderTuple = { salt, maker: W(Number(salt)), marketId: 1n, option: 0, isBuy: true, price: 5, size: 10n * SH, expiration: BigInt(NOW_S + 3 * 86_400), nonce: 0n, ...o };
      salt++;
      out.push(t.maker);
      insertOrder(state.storage.sql, t, `0x${t.salt.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
    }
  });
  return out;
}

const text = (b: unknown) => JSON.stringify(b).toLowerCase();

describe('adversary R12: whole-book party check', () => {
  it('refused roles at every multicall chunk boundary never reach a proposal', async () => {
    const n = MAX_BOOK_ORDERS - 2;
    const asks = await book(Array.from({ length: n }, () => ({ isBuy: false, price: 40 })));
    asks.forEach((w, i) => {
      const edge = i % ROLE_CHUNK === 0 || i % ROLE_CHUNK === ROLE_CHUNK - 1 || i === n - 1;
      if (edge) h.w.operators.add(w.toLowerCase() as Hex);
      else h.refused.add(w.toLowerCase());
    });
    const [ask] = await book([{ isBuy: false, price: 45 }]);
    const [bid] = await book([{ isBuy: true, price: 50 }]);
    await h.tick();
    expect(h.settled).toHaveLength(1);
    expect(text(h.settled[0])).toContain(ask.toLowerCase());
    expect(text(h.settled[0])).toContain(bid.toLowerCase());
    for (const w of asks) expect(text(h.settled[0])).not.toContain(w.toLowerCase());
  });

  it('a read that fails after earlier chunks succeeded proposes nothing', async () => {
    const asks = await book(Array.from({ length: 700 }, () => ({ isBuy: false, price: 40 })));
    for (const w of asks) h.w.operators.add(w.toLowerCase() as Hex);
    await book([{ isBuy: false, price: 45 }]);
    await book([{ isBuy: true, price: 50 }]);
    let seen = 0;
    h.w.fail = (_m, name) => (name === 'aggregate3' && ++seen === 3 ? 'down' : null);
    await h.tick();
    expect(h.settled).toHaveLength(0);
    h.w.fail = null;
    h.w.nowMs += TICK_MS;
    await h.tick();
    expect(h.settled, 'recovered: the clean pair goes').toHaveLength(1);
  });

  it('UTC day turn: an account refused for the day has its order dropped, and the new day does not bring it back (plan 6.2, Codex R6 F1)', async () => {
    const [refusedAsk] = await book([{ isBuy: false, price: 40 }]);
    h.refused.add(refusedAsk.toLowerCase());
    await book([{ isBuy: true, price: 50 }]);
    const midnight = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
    h.w.nowMs = midnight - 30_000;
    await h.tick();
    expect(h.settled).toHaveLength(0);
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, refusedAsk.toLowerCase()))[0].n, 'dropped as refused').toBe(0);
    h.turnDay(midnight + 1_000);
    await h.tick();
    expect(h.settled, 'the dropped order does not come back on the new day').toHaveLength(0);
  });

  it('worst alarm tick: full book, 5 log chunks, stale mark, role reads, list read and hand-off stay under 50 subrequests', async () => {
    const asks = await book(Array.from({ length: MAX_BOOK_ORDERS - 3 }, () => ({ isBuy: false, price: 40 })), { cursor: '1' });
    for (const w of asks) h.refused.add(w.toLowerCase());
    await book([{ isBuy: false, price: 45 }]);
    const [bid] = await book([{ isBuy: true, price: 50 }]);
    await runInDurableObject(h.stub, (_i, state) => {
      markInFlight(state.storage.sql, [`0x${(1n).toString(16).padStart(64, '0')}` as Hex], NOW_MS - 10 * 60_000);
    });
    h.w.block = 100_000n;
    let n = 0;
    const innerFetch = h.deps.fetch;
    h.deps.fetch = ((i: RequestInfo | URL, x?: RequestInit) => {
      n++;
      return innerFetch(i, x);
    }) as typeof fetch;
    const innerList = h.deps.refusedList;
    h.deps.refusedList = async () => {
      n++;
      return innerList();
    };
    const innerHeld = h.deps.held;
    h.deps.held = async () => {
      n++;
      return innerHeld();
    };
    const innerSettle = h.deps.settle;
    h.deps.settle = async (b) => {
      n++;
      return innerSettle(b);
    };
    await h.tick();
    console.log(`subrequests in the worst tick: ${n}`);
    expect(h.settled).toHaveLength(1);
    expect(text(h.settled[0])).toContain(bid.toLowerCase());
    expect(n, `subrequests ${n}`).toBeLessThanOrEqual(50);
  });
});
