// Codex MATCHER R5 F1: a market proposes from the settler's refusal list as it read it; the settler may refuse an
// account after that read (another market's failed settlement). The settler now checks its list when it accepts a
// hand-off (settle.ts submit), the market releases its marks on that answer, and its next pass reads the new list.
import { beforeEach, describe, expect, it } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { insertOrder, setMeta } from '../src/book';
import { utcDay } from '../src/settle';
import type { OrderTuple } from '../src/abi';
import { fresh, fund, type Harness } from './harness';
import { NOW_MS } from './fake';
import { vec } from './vectors';
import { prop, rows, withSettler } from './settle-helpers';

const NOW_S = Math.floor(NOW_MS / 1000);
const SH = 1_000_000n;
const W = (n: number) => `0x${(0xe000_0000 + n).toString(16).padStart(40, '0')}` as Hex;

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
  h.settlerChecksRefusals = true; // the fake settler applies settle.ts submit's rule
});

/// The list is read, and before the read returns, the settler refuses `who` (the snapshot the market gets does not
/// name it).
/// `nth`: which list read is the matching pass's (an alarm tick first reads the list to drop refused orders, then the
/// pass reads it; intake's pass is its first read).
function refuseAfterSnapshot(who: Hex, nth = 1) {
  const inner = h.deps.refusedList;
  let reads = 0;
  h.deps.refusedList = async () => {
    const snap = await inner();
    if (++reads === nth) h.refused.add(who.toLowerCase());
    return snap;
  };
}

const makers = (b: unknown) => JSON.stringify(b).toLowerCase();

describe('Codex MATCHER R5 F1: an account refused after the market read the list is never accepted in a hand-off', () => {
  it('alarm path: the hand-off is refused, its marks released, and the next pass matches without the account', async () => {
    h.w.markets.set('1', { nOptions: 3, status: 1, tradingClose: 4_000_000_000n, positionCap: 10n ** 12n, feeRate: 0n });
    await runInDurableObject(h.stub, (_i, state) => {
      setMeta(state.storage.sql, 'n_options', '3');
      setMeta(state.storage.sql, 'log_cursor', '5000');
      const rows: [number, boolean, number][] = [[1, false, 40], [2, false, 45], [3, true, 50]]; // asks at 40, 45; bid at 50 newest
      for (const [n, isBuy, price] of rows) {
        const t: OrderTuple = { salt: BigInt(n), maker: W(n), marketId: 1n, option: 0, isBuy, price, size: 10n * SH, expiration: BigInt(NOW_S + 86_400), nonce: 0n };
        insertOrder(state.storage.sql, t, `0x${n.toString(16).padStart(64, '0')}` as Hex, '0x11', 0n, 0n, NOW_MS);
      }
    });
    refuseAfterSnapshot(W(1), 2); // the best ask's account, refused right after the pass read the list
    await h.tick();
    expect(h.settled, 'nothing accepted').toHaveLength(0);
    expect(h.refusedHandoffs).toHaveLength(1);
    expect(makers(h.refusedHandoffs[0])).toContain(W(1).toLowerCase());
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE in_flight = 1`))[0].n, 'marks released on the refusal').toBe(0);
    for (let i = 0; i < 5 && h.settled.length === 0; i++) await h.tick();
    expect(h.settled).toHaveLength(1);
    expect(makers(h.settled[0])).not.toContain(W(1).toLowerCase());
    expect(makers(h.settled[0])).toContain(W(2).toLowerCase());
  });

  it("intake path: a taker's own pass hands off a maker refused since the read; it is refused, and the next tick matches the next maker", async () => {
    for (const n of ['direct3Maker1Sell', 'direct3Maker2Sell']) {
      fund(h.w, vec(n).order, 500_000_000n);
      await h.place(vec(n));
    }
    refuseAfterSnapshot(vec('direct3Maker1Sell').order.maker); // the best price
    fund(h.w, vec('directTakerBuy').order, 500_000_000n);
    await h.place(vec('directTakerBuy'));
    expect(h.settled).toHaveLength(0);
    expect(h.refusedHandoffs).toHaveLength(1);
    for (let i = 0; i < 5 && h.settled.length === 0; i++) await h.tick();
    expect(h.settled).toHaveLength(1);
    expect(makers(h.settled[0])).not.toContain(vec('direct3Maker1Sell').order.maker.toLowerCase());
  });
});

describe('the real settler refuses a hand-off naming an account refused today (settle.ts submit)', () => {
  it('refused today: not accepted, nothing pending; refused on another day: accepted', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('directTakerBuy', ['directMakerSell']);
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', p.makers[0].order.maker, utcDay(r.w.nowMs), 'bad_signature', 1);
      const s = mk(sql);
      expect(await s.submit(p)).toEqual({ accepted: false, reason: 'party_refused' });
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')[0]).toEqual({ n: 0 });
      sql.exec('UPDATE refused_accounts SET utc_day = ?', '2001-01-01');
      expect(await s.submit(p)).toEqual({ accepted: true });
    });
  });

  it('the taker refused today is refused too', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('directTakerBuy', ['directMakerSell']);
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', p.taker.order.maker, utcDay(r.w.nowMs), 'bad_signature', 1);
      expect(await mk(sql).submit(p)).toEqual({ accepted: false, reason: 'party_refused' });
    });
  });
});
