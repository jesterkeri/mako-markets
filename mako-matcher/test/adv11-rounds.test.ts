// Adversary R11 on acc1038: a taker whose proposals keep naming refused wallets gives up after MAX_PARTY_CHECK_ROUNDS
// rounds and the pass moves on as if it had searched it all. matchPass then returns `finished: true`, so a rotation
// where nothing else is found counts as CLEAN, the book goes idle, and the clean pair sitting behind the refused
// wallets is hidden: the taker is not tried again until the book changes or IDLE_RECHECK_MS passes, and by then the
// refused_cache rows (kept at most IDLE_RECHECK_MS from when found) are gone, so the next rotation spends its rounds
// on the same refused wallets again. The read-budget stop returns budgetStop so it continues next tick; this path
// does not.
// Since Codex MATCHER R4 F1 there are no rounds and no cache: a pass reads every maker at once, so this book is handed
// over on the first tick. The scenario is kept as a regression test.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import { IDLE_RECHECK_MS, TICK_MS } from '../src/config';
import type { OrderTuple } from '../src/abi';
import { fresh, type Harness } from './harness';
import { NOW_MS } from './fake';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xb000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
let salt = 1n;
beforeEach(async () => {
  h = await fresh('1');
  salt = 1n;
});

async function book(orders: Partial<OrderTuple>[], nOptions: number) {
  h.w.markets.set('1', { nOptions, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
  await runInDurableObject(h.stub, (_i, state) => {
    setMeta(state.storage.sql, 'n_options', String(nOptions));
    setMeta(state.storage.sql, 'log_cursor', '5000');
    for (const o of orders) {
      const t: OrderTuple = {
        salt, maker: W(Number(salt)), marketId: 1n, option: 0, isBuy: true, price: 5, size: 10n * SH,
        expiration: BigInt(NOW_S + 86_400), nonce: 0n, ...o,
      };
      salt++;
      insertOrder(state.storage.sql, t, `0x${t.salt.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
    }
  });
}

/// Five (the old round limit) refused asks at 40 cents ahead of one clean ask at 45, and the same number of refused bids at
/// 60 ahead of one clean bid at 50. The clean bid and the clean ask cross, and each is the only clean counterparty of
/// the other, so whichever is tried as the taker gives up after its rounds. Nothing is refused but the ten wallets.
async function stuckBook() {
  const n = 5;
  await book(Array.from({ length: n }, () => ({ isBuy: true, price: 60 })), 3); // refused bids
  await book(Array.from({ length: n }, () => ({ isBuy: false, price: 40 })), 3); // refused asks
  await book([{ isBuy: false, price: 45 }], 3); // the clean ask
  await book([{ isBuy: true, price: 50 }], 3); // the clean bid, newest
  for (let i = 1; i <= 2 * n; i++) h.refused.add(W(i).toLowerCase());
}

describe('a taker that spends its party-check rounds on refused wallets is not written off as searched', () => {
  it('the clean crossing pair behind refused wallets is handed over on the first tick', async () => {
    await stuckBook();
    await h.tick();
    expect(h.settled, 'the clean bid and ask cross; every refused wallet is known before the search').toHaveLength(1);
  });

  it('control: with nobody refused the same book hands the pair over on the first tick', async () => {
    await stuckBook();
    h.refused.clear();
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });

  it('the book is never declared idle before the pair is handed over (so it never waits for an idle recheck)', async () => {
    // ticks come every TICK_MS while the book is not idle; the cache lasts IDLE_RECHECK_MS, far longer
    expect(IDLE_RECHECK_MS).toBeGreaterThan(10 * TICK_MS);
    await stuckBook();
    for (let i = 0; i < 6 && h.settled.length === 0; i++) {
      await h.tick();
      if (h.settled.length === 0) expect((await h.sql(`SELECT k FROM meta WHERE k = 'idle_fp'`)).length, `idle at tick ${i + 1} with the pair unmatched`).toBe(0);
      h.w.nowMs += TICK_MS;
    }
    expect(h.settled).toHaveLength(1);
  });
});
