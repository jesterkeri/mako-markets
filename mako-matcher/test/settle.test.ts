import { describe, expect, it } from 'vitest';
import { parseTransaction, type Hex } from 'viem';
import { GAS_CEILING } from '../src/settle';
import { DIRECT, drive, prop, rows, withSettler } from './settle-helpers';
import { GWEI, OP, OP2, rig } from './settle-world';
import { vec } from './vectors';

const sendsToday = (sql: SqlStorage) => rows<{ sends: number; mon_reserved: string }>(sql, 'SELECT sends, mon_reserved FROM counters')[0];

describe('a settled direct match', () => {
  it('encodes from the records, simulates, sends type 2 at twice the base fee, and reports the fills', async () => {
    await withSettler(async (sql, r, mk) => {
      const s = mk(sql);
      const p = DIRECT();
      expect(await drive(s, p)).toEqual({ accepted: true });
      expect(r.w.sent).toHaveLength(1);
      const sent = r.w.sent[0];
      expect(sent.from).toBe(OP.address.toLowerCase());
      // the call is the vectors' T1 call byte for byte
      expect(sent.input).toBe(decodeAs(p));
      const tx = parseTransaction(sent.raw);
      expect(tx.type).toBe('eip1559');
      expect(tx.maxFeePerGas).toBeGreaterThanOrEqual(2n * r.w.baseFeePerGas);
      expect(tx.gas).toBe(330_000n); // ceil(300,000 x 1.10) rounded up to 1,000
      expect(tx.to?.toLowerCase()).toBe('0xe8c0000000000000000000000000000000000001');
      expect(r.outcomes).toHaveLength(1);
      expect(r.outcomes[0].marketId).toBe('1');
      expect(r.outcomes[0].body.applied).toEqual([
        { hash: p.taker.hash, fill: '100000000' },
        { hash: p.makers[0].hash, fill: '100000000' },
      ]);
      expect(r.outcomes[0].body.release).toEqual([p.taker.hash, p.makers[0].hash]);
      expect(rows(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'settled' }]);
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')).toEqual([{ n: 0 }]);
    });
  });

  it('the charge is the gas limit times the effective price, and it replaces the reservation', async () => {
    await withSettler(async (sql, r, mk) => {
      const s = mk(sql);
      r.w.onSend = () => ({ status: 1 });
      await drive(s, DIRECT());
      const eff = r.w.baseFeePerGas + r.w.prio;
      const log = rows<{ reserved: string; charge: string }>(sql, 'SELECT reserved, charge FROM send_log')[0];
      expect(BigInt(log.reserved)).toBe(330_000n * (2n * r.w.baseFeePerGas + r.w.prio));
      expect(BigInt(log.charge)).toBe(330_000n * eff);
      expect(BigInt(sendsToday(sql).mon_reserved)).toBe(330_000n * eff);
    });
  });

  it('writes the send log before it broadcasts, with the hash, sender, nonce, gas limit and max fee', async () => {
    await withSettler(async (sql, r, mk) => {
      let seen: Record<string, unknown>[] = [];
      let inflight = 0;
      r.broadcastLog = (q) => {
        seen = rows(q, 'SELECT hash, sender, nonce, gas_limit, max_fee FROM send_log');
        inflight = rows<{ n: number }>(q, 'SELECT COUNT(*) AS n FROM in_flight')[0].n;
      };
      await drive(mk(sql), DIRECT());
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ hash: r.w.sent[0].hash, sender: OP.address.toLowerCase(), nonce: 0, gas_limit: '330000' });
      expect(BigInt(seen[0].max_fee as string)).toBeGreaterThanOrEqual(2n * r.w.baseFeePerGas);
      expect(inflight).toBe(1);
    });
  });

  it('takes the nonce from the chain plus the log, never below a logged one', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.confirmedNonce.set(OP.address.toLowerCase() as Hex, 7n);
      await drive(mk(sql), DIRECT());
      expect(r.w.sent[0].tx.nonce).toBe(7);
      // the node forgets its count (a restart, a lagging node): the log still says 7 was used
      r.w.confirmedNonce.set(OP.address.toLowerCase() as Hex, 0n);
      r.w.sent.length = 0;
      await drive(mk(sql), DIRECT());
      expect(r.w.sent[0].tx.nonce).toBe(8);
    });
  });
});

function decodeAs(p: ReturnType<typeof DIRECT>): Hex {
  // the vectors' T1@testnet calldata
  const c = (vecCalls() as { id: string; calldata: Hex }[]).find((x) => x.id === 'T1@testnet')!;
  void p;
  return c.calldata;
}
import { V } from './vectors';
function vecCalls() {
  return V.calls;
}

describe('fail closed: what is not configured is never sent', () => {
  const cases: [string, (r: ReturnType<typeof rig>) => void, string][] = [
    ['K unset', (r) => (r.over.K = null), 'held_k_unset'],
    ['no funder address', (r) => (r.over.funder = null), 'held_funder_unset'],
    ['no operator key', (r) => (r.over.key = null), 'held_no_key'],
  ];
  for (const [name, set, code] of cases) {
    it(`${name}: the proposal is refused, nothing is sent, and it alerts once`, async () => {
      await withSettler(async (sql, r, mk) => {
        set(r);
        const s = mk(sql);
        expect(await s.submit(DIRECT())).toEqual({ accepted: false, reason: code });
        expect(await s.submit(DIRECT())).toEqual({ accepted: false, reason: code });
        expect(r.w.sent).toEqual([]);
        expect(r.alerts.filter((a) => a.code === code)).toHaveLength(1);
        expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')).toEqual([{ n: 0 }]);
      });
    });
  }

  it('an unreadable funder cap holds the match (it goes back to the book) and sends nothing', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.funderCap = null;
      const s = mk(sql);
      await drive(s, DIRECT());
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes).toHaveLength(1);
      expect(r.outcomes[0].body.applied).toBeUndefined();
      expect(r.outcomes[0].body.dropped).toBeUndefined();
      expect(r.alerts.map((a) => a.code)).toContain('held_funder_unreadable');
      // and when it can be read, the next proposal goes
      r.w.funderCap = 10n ** 20n;
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('a malformed proposal is refused', async () => {
    await withSettler(async (sql, _r, mk) => {
      expect(await mk(sql).submit({ nonsense: true })).toEqual({ accepted: false, reason: 'bad_proposal' });
    });
  });

  it('holds when the exchange is paused, and sends when it is not (reads paused() each time)', async () => {
    await withSettler(async (sql, r, mk) => {
      const s = mk(sql);
      r.w.paused = true;
      await drive(s, DIRECT());
      expect(r.w.sent).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('held_paused');
      expect(r.outcomes[0].body.dropped).toBeUndefined();
      r.w.paused = false;
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('sends nothing from a key the exchange does not list as an operator', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.key = OP2;
      await drive(mk(sql), DIRECT());
      expect(r.w.sent).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('not_operator');
      r.w.operators.add(OP2.address.toLowerCase() as Hex);
      await drive(mk(sql), DIRECT());
      expect(r.w.sent).toHaveLength(1);
    });
  });
});

describe('the gas limit and the wallet', () => {
  it('a limit above 4,026,000 sends nothing, drops nothing, stops that market and alerts', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.estimate = 3_660_000n; // x 1.10 = 4,026,000 exactly: allowed
      await drive(mk(sql), DIRECT());
      expect(r.w.sent[0].tx.gas).toBe(GAS_CEILING);
    });
    await withSettler(async (sql, r, mk) => {
      r.w.estimate = 3_660_001n; // x 1.10 rounded up to 1,000 is 4,027,000
      await drive(mk(sql), DIRECT());
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes[0].body.stopMarket).toMatch(/above the ceiling/);
      expect(r.outcomes[0].body.dropped).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('gas_ceiling');
      expect(sendsToday(sql).sends).toBe(0);
    });
  });

  it('wallet short: below the worst charge nothing is sent, nothing is dropped or counted, and it resumes when funded', async () => {
    await withSettler(async (sql, r, mk) => {
      const s = mk(sql);
      const need = 330_000n * (2n * r.w.baseFeePerGas + r.w.prio);
      r.w.balance = need - 1n;
      await drive(s, DIRECT());
      expect(r.w.sent).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('wallet_short');
      expect(r.outcomes[0].body).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}-1$/), release: [DIRECT().taker.hash, DIRECT().makers[0].hash] });
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM failures')).toEqual([{ n: 0 }]);
      r.w.balance = need;
      await drive(s, DIRECT());
      expect(r.w.sent).toHaveLength(1);
    });
  });
});

void GWEI;
void prop;
void vec;
