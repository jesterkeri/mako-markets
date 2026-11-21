// Second adversary round on the settler (plan 6.2 "Report back": the in-flight marks are released, orders dropped with a reason).
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { drive, prop, withSettler } from './settle-helpers';
import { V } from './vectors';
import type { Rig } from './settle-world';

function safes(r: Rig) {
  r.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
  r.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
}
const mixed = () => prop('directTakerBuy', ['safeMakerSell', 'direct3Maker1Sell'], ['50000000', '50000000'], '100000000');

describe('adversary 2: every order the market marked in flight is told back (plan 6.2 Report back: in-flight marks released, always the whole proposal)', () => {
  it('a party dropped while the match was rebuilt is not forgotten when the rebuilt match then hits InsufficientGas in the simulation', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = mixed();
      const safeMaker = p.makers[0].order.maker as Hex;
      // the Safe maker's code is no longer the supported proxy: round 0 drops it; the rebuilt match then simulates InsufficientGas
      r.w.code.set(safeMaker, '0x6080604052');
      r.w.sim = () => ({ revert: { name: 'InsufficientGas' } });
      await drive(mk(sql), p, 2);
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes).toHaveLength(1);
      const o = r.outcomes[0].body;
      // The market flagged all three orders in flight. Each must be released or dropped, or it is stuck for good.
      const told = new Set<string>([...o.release, ...(o.dropped ?? []).map((d) => d.hash)]);
      for (const h of [p.taker.hash, p.makers[0].hash, p.makers[1].hash]) expect(told.has(h), `order ${h} is neither released nor dropped`).toBe(true);
    });
  });
});

describe('adversary 2: parties found unsupported are never forgotten (plan 4.6 "checked again before every settlement"; 6.2 the order of an unsupported wallet is dropped)', () => {
  it('a match whose rebuild drops exactly MAX_REBUILDS (4) unsupported wallets is sent or reports them, not held with nothing learned', async () => {
    await withSettler(async (sql, r, mk) => {
      // four Safe-form makers whose addresses are not supported wallets in this world (no Safe code), one EOA maker
      const p = prop('directTakerBuy', ['direct3Maker1Sell', 'safeMakerSell', 'regMakerSell', 'regRevokedMakerSell', 'regSwappedMakerSell'], ['20000000', '20000000', '20000000', '20000000', '20000000'], '100000000');
      await drive(mk(sql), p, 3);
      const told = r.outcomes.flatMap((o) => (o.body.dropped ?? []).map((d) => d.hash));
      const progressed = r.w.sent.length > 0 || told.length > 0;
      expect(progressed, `alerts: ${r.alerts.map((a) => a.code).join(',')}; the same match would be proposed again every tick`).toBe(true);
    });
  });
});

describe('adversary 2: a report whose acknowledgement is lost (plan 6.2 Report back; work committed but not delivered)', () => {
  // The adversary's original test asserted a retry differs byte for byte from the first delivery. The fix keeps the
  // retry identical on purpose (the same outbox id), and the market applies each id once: that half is proven in
  // test/inflight.test.ts ("a redelivered outcome ... is applied once"). This half proves the settler side.
  it('a retried delivery carries the same id as the first, and the next settlement a new one', async () => {
    await withSettler(async (sql, r, mk) => {
      const delivered: { id: string }[] = [];
      let first = true;
      r.over.report = async (_m, body) => {
        delivered.push(body as { id: string });
        if (first) {
          first = false;
          throw new Error('ack lost');
        }
      };
      const s = mk(sql);
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 3);
      await s.run();
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 3);
      expect(delivered.map((d) => d.id)).toEqual(['1', '1', '2']);
    });
  });
});

describe('one market refusing its outcomes does not hold up the others (plan 6.2: the settler reports either way)', () => {
  it('a market that keeps refusing gets none of its later outcomes this pass; another market gets its own', async () => {
    await withSettler(async (sql, r, mk) => {
      const z = `0x${'0'.repeat(64)}`;
      for (const m of ['7', '8', '7']) sql.exec(`INSERT INTO outbox (market_id, body) VALUES (?, ?)`, m, JSON.stringify({ release: [z] }));
      const got: string[] = [];
      r.over.report = async (m, body) => {
        got.push(`${m}:${(body as { id: string }).id}`);
        if (m === '7') throw new Error('market 7 refuses');
      };
      await mk(sql).run();
      // run() flushes at its start and at its end: market 7's first outcome is tried in each, its later one never
      // ahead of it; market 8 is served once
      expect(got).toEqual(['7:1', '8:2', '7:1']);
      expect(sql.exec(`SELECT id FROM outbox ORDER BY id`).toArray()).toEqual([{ id: 1 }, { id: 3 }]);
    });
  });
});
