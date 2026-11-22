// Codex MATCHER R4 F1: a long queue of refused wallets ahead of a clean crossing pair. Checking only a proposal's
// parties found a few refused wallets per tick and kept them in a cache that expired as fast as the search refreshed
// it, so the pair was never reached (Codex: 310 refused asks, 125 ticks, 0 hand-offs). A pass now reads every maker
// on the book at once, so these books are handed over on the first tick, whatever the length of the queue, the time
// that passes, or the UTC day.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import { MAX_BOOK_ORDERS, ROLE_CHUNK, TICK_MS } from '../src/config';
import type { OrderTuple } from '../src/abi';
import { fresh, type Harness } from './harness';
import { NOW_MS } from './fake';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xc000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
let salt = 1n;
beforeEach(async () => {
  h = await fresh('1');
  salt = 1n;
});

/// Books orders, each from its own wallet W(salt); returns their wallets.
async function book(orders: Partial<OrderTuple>[]): Promise<Hex[]> {
  const out: Hex[] = [];
  h.w.markets.set('1', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
  await runInDurableObject(h.stub, (_i, state) => {
    setMeta(state.storage.sql, 'n_options', '3');
    setMeta(state.storage.sql, 'log_cursor', '5000');
    for (const o of orders) {
      const t: OrderTuple = {
        salt, maker: W(Number(salt)), marketId: 1n, option: 0, isBuy: true, price: 5, size: 10n * SH,
        expiration: BigInt(NOW_S + 3 * 86_400), nonce: 0n, ...o,
      };
      salt++;
      out.push(t.maker);
      insertOrder(state.storage.sql, t, `0x${t.salt.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
    }
  });
  return out;
}

/// Codex's book: `n` earlier 10-share asks at 40 whose makers are refused, a clean ask at 45, and a clean bid at 50,
/// the newest order. Only the clean pair can cross.
async function backlog(n: number, refuse: (w: Hex) => void) {
  for (const w of await book(Array.from({ length: n }, () => ({ isBuy: false, price: 40 })))) refuse(w);
  const [ask] = await book([{ isBuy: false, price: 45 }]);
  const [bid] = await book([{ isBuy: true, price: 50 }]);
  return { ask, bid };
}

const pairOf = (b: unknown) => JSON.stringify(b);

describe('Codex MATCHER R4 F1: a queue of refused wallets cannot hide a clean crossing pair', () => {
  it("Codex's book (310 refused for the day): the clean pair is handed over on the first tick, and the rest of the 125 ticks change nothing", async () => {
    const { ask, bid } = await backlog(310, (w) => h.refused.add(w.toLowerCase()));
    await h.tick();
    expect(h.settled, 'handed over on the first tick').toHaveLength(1);
    expect(pairOf(h.settled[0]).toLowerCase()).toContain(ask.toLowerCase());
    expect(pairOf(h.settled[0]).toLowerCase()).toContain(bid.toLowerCase());
    // the settler holds it; the pair stays in flight, and 124 more ticks, past any old cache lifetime, propose nothing
    // that names a refused wallet
    for (let i = 1; i < 125; i++) {
      h.w.nowMs += TICK_MS;
      await h.tick();
    }
    for (const s of h.settled) for (let n = 1; n <= 310; n++) expect(pairOf(s).toLowerCase()).not.toContain(W(n).toLowerCase());
  });

  it('the same with every one of them a refused role on chain (an operator) instead of the daily list', async () => {
    await backlog(310, (w) => h.w.operators.add(w.toLowerCase() as Hex));
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });

  it('a full book (MAX_BOOK_ORDERS, all but the pair refused) costs at most ceil(n / ROLE_CHUNK) multicalls plus one list read, and hands the pair over', async () => {
    const n = MAX_BOOK_ORDERS - 2;
    await backlog(n, (w) => h.refused.add(w.toLowerCase()));
    let listReads = 0;
    const inner = h.deps.refusedList;
    h.deps.refusedList = async () => {
      listReads++;
      return inner();
    };
    const before = h.w.exchangeCalls('aggregate3');
    await h.tick();
    const multicalls = h.w.exchangeCalls('aggregate3') - before;
    console.log(`full book: ${multicalls} multicalls + ${listReads} list read`);
    expect(multicalls).toBeLessThanOrEqual(Math.ceil(MAX_BOOK_ORDERS / ROLE_CHUNK));
    expect(listReads).toBe(1);
    expect(h.settled).toHaveLength(1);
  });

  it('fairness: a taker whose every counterparty is refused does not hold up an older clean pair on another option', async () => {
    // the older clean pair, on option 1
    await book([{ option: 1, isBuy: false, price: 30 }, { option: 1, isBuy: true, price: 35 }]);
    // 200 refused asks on option 0, then the newest order: a bid that crosses only them
    for (const w of await book(Array.from({ length: 200 }, () => ({ option: 0, isBuy: false, price: 40 })))) h.refused.add(w.toLowerCase());
    await book([{ option: 0, isBuy: true, price: 50, size: 100n * SH }]);
    await h.tick();
    expect(h.settled, 'the blocked bid is searched once and the pass moves on to the older pair').toHaveLength(1);
    expect(pairOf(h.settled[0]).toLowerCase()).toContain(W(1).toLowerCase());
    expect(pairOf(h.settled[0]).toLowerCase()).toContain(W(2).toLowerCase());
  });

  it('UTC rollover: a pair blocked by a wallet refused for the day is handed over on the first tick of the next day', async () => {
    // the clean bid crosses only the refused ask
    const [refusedAsk] = await book([{ isBuy: false, price: 40 }]);
    h.refused.add(refusedAsk.toLowerCase());
    await book([{ isBuy: true, price: 50 }]);
    // ticks through the day, the last one just before midnight: nothing
    const midnight = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
    for (let i = 0; i < 5; i++) {
      await h.tick();
      h.w.nowMs += TICK_MS;
    }
    h.w.nowMs = midnight - 1;
    await h.tick();
    expect(h.settled).toHaveLength(0);
    // the new day: the settler's list for it does not name the wallet
    h.w.nowMs = midnight + 1;
    h.refused.clear();
    await h.tick();
    expect(h.settled, 'the UTC day is in the idle fingerprint, and the new pass reads the new list').toHaveLength(1);
  });

  it('fails closed: with the settler list unreadable nothing is proposed, and the next readable tick hands the pair over', async () => {
    await backlog(20, (w) => h.refused.add(w.toLowerCase()));
    h.settlerDown = true;
    await h.tick();
    expect(h.settled).toHaveLength(0);
    expect((await h.alerts()).map((a) => a.code)).toContain('match_read_failed');
    h.settlerDown = false;
    h.w.nowMs += TICK_MS;
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });
});
