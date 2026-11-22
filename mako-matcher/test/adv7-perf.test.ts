// Seventh adversary round, matching. The matcher runs per incoming order inside a Cloudflare Worker, and matchPass
// proposes once per booked taker on every tick, so one propose() call must stay cheap even when no legal fill exists.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { BookOrder } from '../src/book';
import { propose, type MatchOpts } from '../src/match';

const NOW_S = 1_999_900_000;
const SH = 1_000_000n;
const W = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex;
const opts: MatchOpts = { nOptions: 2, nowSeconds: NOW_S, blocked: () => false };

function mk(seq: number, maker: number, isBuy: boolean, price: number, shares: number): BookOrder {
  const size = BigInt(shares) * SH;
  return {
    seq, hash: `0x${seq.toString(16).padStart(64, '0')}` as Hex, salt: 1n, marketId: 1n, expiration: 2_000_000_000n, nonce: 0n,
    signature: '0x11' as Hex, fee: 0n, createdAt: 0, size, filled: 0n, remaining: size, maker: W(maker), option: 0, isBuy, price, inFlight: false,
  } as unknown as BookOrder;
}

describe('adv7: worst-case CPU of one propose() call', () => {
  it('a 10-share buy against ten 7-share asks (no legal fill, 3^10 search) answers in well under 50 ms', () => {
    // Asks of 7 shares fill whole only; 7k never equals 10, so greedy fails and the exact search runs (asks under 10 shares cannot rest via intake today, so this is a bound, not a live case).
    const book = Array.from({ length: 10 }, (_, i) => mk(i + 1, i + 2, false, 50, 7));
    const taker = mk(100, 1, true, 60, 10);
    const all = [...book, taker];
    const t0 = performance.now();
    const p = propose(taker, all, opts);
    const ms = performance.now() - t0;
    console.log(`adv7 perf: propose took ${ms.toFixed(1)} ms, proposal=${p === null ? 'null' : 'some'}`);
    expect(p).toBeNull();
    expect(ms, `one propose() call took ${ms.toFixed(1)} ms`).toBeLessThan(50);
  });
});
