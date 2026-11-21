// Adversary attacks on the settler (plan 6.2, 6.3, 6.5). Each test names the spec rule it holds the code to.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { drive, prop, rows, withSettler } from './settle-helpers';
import { OP, type Rig } from './settle-world';
import { V } from './vectors';

const op = OP.address.toLowerCase() as Hex;
const counters = (sql: SqlStorage) => rows<{ utc_day: string; sends: number; mon_reserved: string }>(sql, 'SELECT utc_day, sends, mon_reserved FROM counters ORDER BY utc_day');
function safes(r: Rig) {
  r.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
  r.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
}
const mixed = () => prop('directTakerBuy', ['safeMakerSell', 'direct3Maker1Sell'], ['50000000', '50000000'], '100000000');
const PAUSED = () => ({ revert: { name: 'Paused' } });

describe('adversary: MON reservation accounting (plan 6.3, "the charge replaces the reservation")', () => {
  it('a mined revert whose calldata read (eth_getTransactionByHash) fails once and is retried releases its reservation once, not twice', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = PAUSED;
      const s = mk(sql);
      await s.submit(mixed());
      safes(r);
      r.w.failMethod['eth_getTransactionByHash'] = 'down';
      await s.run();
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')[0]).toEqual({ n: 1 });
      r.w.failMethod['eth_getTransactionByHash'] = undefined;
      await s.run();
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')[0]).toEqual({ n: 0 });
      const charge = BigInt(rows<{ charge: string }>(sql, 'SELECT charge FROM send_log')[0].charge);
      expect(BigInt(counters(sql)[0].mon_reserved)).toBe(charge);
    });
  });

  it('a calldata read that keeps failing does not drain the counter tick by tick', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = PAUSED;
      const s = mk(sql);
      await s.submit(mixed());
      safes(r);
      r.w.failMethod['eth_getTransactionByHash'] = 'down';
      for (let i = 0; i < 4; i++) await s.run();
      const charge = BigInt(rows<{ charge: string }>(sql, 'SELECT charge FROM send_log')[0].charge);
      expect(BigInt(counters(sql)[0].mon_reserved)).toBe(charge);
    });
  });
});

describe('adversary: a UTC day that ends mid-settlement (plan 6.3, "K ... per UTC day", counters keyed by UTC day)', () => {
  it('a settlement that crosses 00:00 UTC is not sent on the old day counters; the next send counts against the new day, and K = 1 holds there', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.K = 1n;
      r.w.nowMs = Date.UTC(2033, 5, 1, 23, 59, 59, 900);
      const inner = r.w.hooks!;
      let crossed = false;
      r.w.hooks = async (m, p) => {
        // the node is slow to answer the gas estimate: midnight passes while the settler waits
        if (m === 'eth_estimateGas' && !crossed) {
          crossed = true;
          r.w.nowMs = Date.UTC(2033, 5, 2, 0, 0, 0, 100);
        }
        return inner(m, p);
      };
      const s = mk(sql);
      // midnight passed during the reads: the caps were checked against the old day, so nothing is sent and the
      // orders go back to the book
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 2);
      expect(r.w.sent).toHaveLength(0);
      expect(r.outcomes.at(-1)!.body.release.length).toBe(2);
      // proposed again on the new day: sent and counted against that day
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 2);
      expect(r.w.sent).toHaveLength(1);
      expect(rows(sql, 'SELECT utc_day FROM send_log')).toEqual([{ utc_day: '2033-06-02' }]);
      // same UTC day, K = 1 already used by the send above
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 2);
      expect(r.w.sent).toHaveLength(1);
      expect(counters(sql).find((c) => c.utc_day === '2033-06-02')?.sends).toBe(1);
    });
  });
});

describe('adversary: orders left marked in flight (plan 6.2 "Report back")', () => {
  it('a stranded transaction that was rebuilt without a dropped party still tells the market about that party', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = mixed();
      r.w.code.set(p.makers[0].order.maker, '0x6080604052'); // the first maker's wallet is no longer supported
      r.w.onSend = () => ({ pending: true });
      await drive(mk(sql), p, 1);
      expect(r.w.sent).toHaveLength(1);
      r.w.confirmedNonce.set(op, 1n); // the nonce passes the logged one with no receipt: stranded
      await mk(sql).run();
      expect(rows(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'stranded' }]);
      const o = r.outcomes.at(-1)!.body;
      // the market marked all three orders in flight; each must be released or dropped by this one report
      const covered = new Set<string>([...o.release, ...(o.dropped ?? []).map((d) => d.hash)]);
      for (const rec of [p.taker, ...p.makers]) expect(covered.has(rec.hash)).toBe(true);
    });
  });
});
