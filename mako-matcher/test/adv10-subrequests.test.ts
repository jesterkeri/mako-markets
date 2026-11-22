// Adversary R10 on 4b7d002: TICK_WORK counts the search's CPU, but one taker's party checks are chain and settler reads
// that no counter charges. wrangler.toml declares `subrequests = 50` for an invocation. A taker whose every proposed
// maker is refused costs 1 multicall + 1 refusal read per party per round (MAX_PARTY_CHECK_ROUNDS = 5 rounds, up to 10
// makers each), and "at least one taker per tick" means the budget never stops it. So one tick on a legal book issues
// far more reads than the invocation may make, and in production the 51st read throws, the pass fails closed with the
// cursor unmoved (`resumeBelow: null`), and the same newest orders are retried every tick.
// Since Codex MATCHER R4 F1 a pass reads every maker at once (roles in multicalls of ROLE_CHUNK, the settler's list in
// one read), so these scenarios now cost a few reads; the tests keep the limit and the hand-over.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import type { OrderTuple } from '../src/abi';
import wrangler from '../wrangler.toml?raw';
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

describe('one alarm tick stays inside the invocation subrequest limit', () => {
  it('a taker whose proposed makers are all refused does not spend more reads than wrangler.toml allows', async () => {
    const limit = Number(/^subrequests\s*=\s*(\d+)/m.exec(wrangler)?.[1]);
    expect(limit).toBe(50);
    // 60 resting asks of 10 shares from 60 different wallets, every one refused for the day
    await book(Array.from({ length: 60 }, () => ({ option: 0, isBuy: false, price: 40, size: 10n * SH })), 3);
    for (let n = 1; n <= 60; n++) h.refused.add(W(n).toLowerCase());
    // then ONE clean taker: a 100-share bid that crosses them, so each round proposes 10 refused makers
    await book([{ option: 0, isBuy: true, price: 50, size: 100n * SH }], 3);
    let refusalReads = 0;
    const inner = h.deps.refusedList;
    h.deps.refusedList = async () => {
      refusalReads++;
      return inner();
    };
    const before = h.w.calls.length;
    await h.tick();
    const subrequests = h.w.calls.length - before + refusalReads;
    console.log(`one tick: ${h.w.calls.length - before} chain calls + ${refusalReads} settler refusal reads = ${subrequests}`);
    expect(subrequests, `subrequests in one tick (limit ${limit})`).toBeLessThanOrEqual(limit);
  });

  it('with the limit enforced (the 51st read throws), the oldest crossing pair is still handed over', async () => {
    // the oldest pair: a clean ask at 60 and a clean bid at 70 on option 0
    await book([{ option: 0, isBuy: false, price: 60, size: 20n * SH }, { option: 0, isBuy: true, price: 70, size: 20n * SH }], 3);
    await book(Array.from({ length: 60 }, () => ({ option: 0, isBuy: false, price: 40, size: 10n * SH })), 3);
    for (let n = 3; n <= 62; n++) h.refused.add(W(n).toLowerCase());
    await book([{ option: 0, isBuy: true, price: 50, size: 100n * SH }], 3);
    // what Workers does: the 51st subrequest of one invocation throws
    let used = 0;
    const spend = () => {
      if (++used > 50) throw new Error('Too many subrequests');
    };
    const innerFetch = h.deps.fetch;
    h.deps.fetch = (async (i: RequestInfo | URL, x?: RequestInit) => {
      spend();
      return innerFetch(i, x);
    }) as typeof fetch;
    const innerRefused = h.deps.refusedList;
    h.deps.refusedList = async () => {
      spend();
      return innerRefused();
    };
    let handedAt = -1;
    for (let i = 0; i < 40 && handedAt < 0; i++) {
      used = 0;
      await h.tick();
      if (h.settled.length > 0) handedAt = i + 1;
    }
    const codes = (await h.alerts()).map((a) => a.code);
    console.log(`handed over at tick ${handedAt}; alerts ${[...new Set(codes)].join(',')}`);
    expect(handedAt, 'the oldest pair was handed over within 40 ticks').toBeGreaterThan(0);
  });

  it('control: the same book with no subrequest limit hands the oldest pair over on the first tick', async () => {
    await book([{ option: 0, isBuy: false, price: 60, size: 20n * SH }, { option: 0, isBuy: true, price: 70, size: 20n * SH }], 3);
    await book(Array.from({ length: 60 }, () => ({ option: 0, isBuy: false, price: 40, size: 10n * SH })), 3);
    for (let n = 3; n <= 62; n++) h.refused.add(W(n).toLowerCase());
    await book([{ option: 0, isBuy: true, price: 50, size: 100n * SH }], 3);
    await h.tick();
    expect(h.settled).toHaveLength(1);
  });

  it('each pass reads the refusal list once and remembers nothing for the next pass', async () => {
    await book(Array.from({ length: 10 }, () => ({ option: 0, isBuy: false, price: 40, size: 10n * SH })), 3);
    for (let n = 1; n <= 10; n++) h.refused.add(W(n).toLowerCase());
    await book([{ option: 0, isBuy: true, price: 50, size: 100n * SH }], 3);
    let reads = 0;
    const inner = h.deps.refusedList;
    h.deps.refusedList = async () => {
      reads++;
      return inner();
    };
    await h.tick();
    expect(reads, 'one list read for the whole pass').toBe(1);
    expect(h.settled).toHaveLength(0);
    // a wallet taken off the list is matched by the next pass: nothing was cached
    h.refused.delete(W(1).toLowerCase());
    await book([{ option: 1, isBuy: true, price: 5, size: 10n * SH }], 3); // the book changed (no idle skip)
    await h.tick();
    expect(reads).toBe(2);
    expect(h.settled).toHaveLength(1);
  });
});
