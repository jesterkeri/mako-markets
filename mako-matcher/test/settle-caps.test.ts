import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { DIRECT, drive, rows, withSettler } from './settle-helpers';
import { OP, OP2 } from './settle-world';

const counters = (sql: SqlStorage) => rows<{ sends: number; mon_reserved: string; cap_wei: string }>(sql, 'SELECT sends, mon_reserved, cap_wei FROM counters')[0];

describe('the daily count cap K (plan 6.3)', () => {
  it('with K = 5 and twelve proposals exactly 5 are sent, settled and reverted ones counted alike, and nothing is dropped', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.K = 5n;
      // sends 2 and 4 revert with an error that drops nothing and counts against no one
      r.w.onSend = (_s, n) => (n % 2 === 0 ? { revert: { name: 'Paused' } } : { status: 1 });
      const s = mk(sql);
      const seen70: number[] = [];
      for (let i = 0; i < 12; i++) {
        await drive(s, DIRECT());
        seen70.push(r.alerts.filter((a) => a.code === 'cap_70_count').length);
      }
      // 70% of 5 is 3.5: no alert after 3 sends, one from the 4th on, never a second
      expect(seen70.slice(0, 5)).toEqual([0, 0, 0, 1, 1]);
      expect(r.w.sent).toHaveLength(5);
      expect(counters(sql).sends).toBe(5);
      expect(r.outcomes).toHaveLength(12);
      for (const o of r.outcomes) expect(o.body.dropped ?? []).toEqual([]);
      expect(r.alerts.filter((a) => a.code === 'cap_count')).toHaveLength(1);
      // 70% of 5 is 3.5: the alert fires once, at the 4th send
      expect(r.alerts.filter((a) => a.code === 'cap_70_count')).toHaveLength(1);
    });
  });

  it('resets at 00:00:00 UTC, and a send at 23:59:59 counts against the day it was sent', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.K = 1n;
      const s = mk(sql);
      r.w.nowMs = Date.UTC(2033, 5, 1, 23, 59, 59, 0);
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(1);
      r.w.nowMs = Date.UTC(2033, 5, 1, 23, 59, 59, 900);
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(1);
      r.w.nowMs = Date.UTC(2033, 5, 2, 0, 0, 0, 0);
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(2);
      expect(rows(sql, 'SELECT utc_day, sends FROM counters ORDER BY utc_day')).toEqual([
        { utc_day: '2033-06-01', sends: 1 },
        { utc_day: '2033-06-02', sends: 1 },
      ]);
    });
  });

  it('survives a restart: the counters are in storage, and a transaction in flight stays reserved', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.K = 2n;
      r.w.onSend = () => ({ pending: true });
      await drive(mk(sql), DIRECT(), 1);
      expect(counters(sql).sends).toBe(1);
      const reserved = BigInt(counters(sql).mon_reserved);
      expect(reserved).toBeGreaterThan(0n);
      // "restart": a new settler object over the same storage; the in-flight transaction blocks the next proposal
      const s2 = mk(sql);
      expect(await s2.submit(DIRECT())).toEqual({ accepted: false, reason: 'busy' });
      expect(BigInt(counters(sql).mon_reserved)).toBe(reserved);
      // the transaction mines: the reservation becomes the charge, and the next proposal is taken
      const log = rows<{ hash: Hex }>(sql, 'SELECT hash FROM send_log')[0];
      r.w.receipts.set(log.hash, { status: 1, effectiveGasPrice: r.w.baseFeePerGas + r.w.prio });
      r.w.confirmedNonce.set(OP.address.toLowerCase() as Hex, 1n);
      await s2.run();
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')).toEqual([{ n: 0 }]);
      expect(BigInt(counters(sql).mon_reserved)).toBe(330_000n * (r.w.baseFeePerGas + r.w.prio));
      expect(r.outcomes).toHaveLength(1);
      r.w.onSend = () => ({ status: 1 });
      await drive(s2, DIRECT());
      expect(r.w.sent).toHaveLength(2);
    });
  });

  it('a key change does not reset the day: 9 of 10 sends used, the new key may send exactly one more', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.K = 10n;
      for (let i = 0; i < 9; i++) await drive(mk(sql), DIRECT());
      expect(r.w.sent).toHaveLength(9);
      r.w.operators.add(OP2.address.toLowerCase() as Hex);
      r.over.key = OP2;
      await drive(mk(sql), DIRECT());
      await drive(mk(sql), DIRECT());
      expect(r.w.sent).toHaveLength(10);
      expect(r.w.sent[9].from).toBe(OP2.address.toLowerCase());
      expect(counters(sql).sends).toBe(10);
    });
  });
});

describe('the daily MON cap C, read from the funder at the start of the day (plan 6.3)', () => {
  const R = 330_000n * (2n * 100_000_000_000n + 2_000_000_000n); // gas limit x maxFeePerGas
  const Ch = 330_000n * (100_000_000_000n + 2_000_000_000n); // gas limit x effective price

  it('two worst-case reservations fit and a third does not: exactly two sends, and a charge frees the difference', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.funderCap = 2n * Ch + R - 1n;
      const s = mk(sql);
      await drive(s, DIRECT());
      expect(BigInt(counters(sql).mon_reserved)).toBe(Ch);
      await drive(s, DIRECT());
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(2);
      expect(BigInt(counters(sql).mon_reserved)).toBe(2n * Ch);
      expect(r.alerts.filter((a) => a.code === 'cap_mon')).toHaveLength(1);
      expect(r.alerts.filter((a) => a.code === 'cap_70_mon')).toHaveLength(1);
      // one wei more room and the third goes
      r.w.funderCap = 2n * Ch + R;
      sql.exec('UPDATE counters SET cap_wei = ?', (2n * Ch + R).toString());
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(3);
    });
  });

  it('reads the cap on the first use of the UTC day, and the day keeps it', async () => {
    await withSettler(async (sql, r, mk) => {
      const s = mk(sql);
      r.w.nowMs = Date.UTC(2033, 5, 1, 1, 0, 0);
      await drive(s, DIRECT());
      expect(counters(sql).cap_wei).toBe((10n ** 20n).toString());
      r.w.funderCap = 10n ** 19n; // changed mid-day: the day does not change
      await drive(s, DIRECT());
      expect(rows(sql, 'SELECT cap_wei FROM counters')).toEqual([{ cap_wei: (10n ** 20n).toString() }]);
      r.w.nowMs = Date.UTC(2033, 5, 2, 0, 0, 1);
      await drive(s, DIRECT());
      expect(rows(sql, 'SELECT utc_day, cap_wei FROM counters ORDER BY utc_day')).toEqual([
        { utc_day: '2033-06-01', cap_wei: (10n ** 20n).toString() },
        { utc_day: '2033-06-02', cap_wei: (10n ** 19n).toString() },
      ]);
    });
  });
});
