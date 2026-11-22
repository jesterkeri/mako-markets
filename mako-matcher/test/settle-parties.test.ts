import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { decodeMatch } from '../src/encode';
import { drive, prop, rows, SAFE_MATCH, withSettler } from './settle-helpers';
import { type Rig } from './settle-world';
import { V } from './vectors';

const failures = (sql: SqlStorage) => rows(sql, 'SELECT * FROM failures');
function safes(r: Rig) {
  r.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
  r.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
}
/// A direct match with one Safe maker and one EOA maker, 50 shares each.
const mixed = () => prop('directTakerBuy', ['safeMakerSell', 'direct3Maker1Sell'], ['50000000', '50000000'], '100000000');
const EVIL = `0x${'ee'.repeat(20)}` as Hex;

describe('a contract party is re-checked before the settlement (plan 4.6)', () => {
  const changes: [string, (r: Rig, maker: Hex) => void][] = [
    ['its fallback handler changed', (r, m) => r.w.storage.set(`${m}:0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5`, `0x${'0'.repeat(24)}${'33'.repeat(20)}`)],
    ['its singleton changed', (r, m) => r.w.storage.set(`${m}:0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${'44'.repeat(20)}`)],
    ['its code is not the proxy', (r, m) => r.w.code.set(m, '0x6080604052')],
  ];
  for (const [what, change] of changes) {
    it(`${what}: the party is dropped, not counted, and the match is rebuilt without it`, async () => {
      await withSettler(async (sql, r, mk) => {
        safes(r);
        const p = mixed();
        change(r, p.makers[0].order.maker);
        await drive(mk(sql), p);
        expect(r.w.sent).toHaveLength(1);
        const d = decodeMatch(r.w.sent[0].input)!;
        expect(d.makers).toHaveLength(1);
        expect(d.makers[0].salt).toBe(BigInt(p.makers[1].order.salt));
        expect(d.takerFill).toBe(50_000_000n);
        expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.makers[0].hash, reason: 'unsupported_wallet' }]);
        expect(r.outcomes[0].body.applied).toEqual([{ hash: p.taker.hash, fill: '50000000' }, { hash: p.makers[1].hash, fill: '50000000' }]);
        expect(failures(sql)).toEqual([]);
      });
    });
  }

  it('a changed taker ends the match: nothing is sent and only the taker is dropped', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = SAFE_MATCH();
      r.w.storage.set(`${p.taker.order.maker}:0x${'0'.repeat(64)}`, `0x${'0'.repeat(24)}${'44'.repeat(20)}`);
      await drive(mk(sql), p);
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.taker.hash, reason: 'unsupported_wallet' }]);
    });
  });

  it('a set match cannot lose a leg: it is abandoned, with only that order dropped', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      // a mint whose first leg is a Safe-form order; its address no longer has the proxy code
      const p = prop('mintTakerBuy0', ['safeMakerSell', 'mintMakerBuy2'], ['100000000', '100000000'], '100000000', 'mint');
      r.w.code.set(p.makers[0].order.maker, '0x6080604052');
      await drive(mk(sql), p);
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.makers[0].hash, reason: 'unsupported_wallet' }]);
    });
  });

  it('a Safe-form signature on an address whose code changed makes the set match abandon that order', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = prop('safeTakerBuy', ['safeMakerSell'], ['100000000'], '100000000');
      r.w.code.set(p.makers[0].order.maker, '0x6080604052');
      await drive(mk(sql), p);
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.makers[0].hash, reason: 'unsupported_wallet' }]);
    });
  });
});

describe('the simulation trace: every frame inside a check frame ran only allowlisted code', () => {
  it('a party whose check frame ran other code is dropped, not counted, and the match is rebuilt without it', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = mixed();
      r.w.sim = (d) => (d!.makers.some((m) => m.maker.toLowerCase() === p.makers[0].order.maker) ? { extraRan: [EVIL], extraFor: p.makers[0].order.maker } : {});
      await drive(mk(sql), p);
      expect(r.w.sent).toHaveLength(1);
      expect(decodeMatch(r.w.sent[0].input)!.makers).toHaveLength(1);
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.makers[0].hash, reason: 'unsupported_wallet' }]);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a trace that shows no signature check for a contract party holds the match', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      r.w.sim = () => ({ noFrames: true });
      await drive(mk(sql), SAFE_MATCH());
      expect(r.w.sent).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('check_frame_missing');
      expect(r.outcomes[0].body.dropped).toBeUndefined();
    });
  });

  it('no simulation trace at all holds the match', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({ noTrace: true });
      await drive(mk(sql), prop('directTakerBuy', ['directMakerSell']));
      expect(r.w.sent).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('simulation_unavailable');
    });
  });
});

describe('records from another market', () => {
  it('builds and sends nothing, abandons the match and alerts, dropping and counting nothing', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('directTakerBuy', ['mmDirectMakerSellB']);
      await drive(mk(sql), p);
      expect(r.w.sent).toEqual([]);
      expect(r.w.calls.some((c) => c.method === 'debug_traceCall' || c.method === 'eth_estimateGas')).toBe(false);
      expect(r.alerts.map((a) => a.code)).toContain('market_mismatch');
      expect(r.outcomes[0].body).toEqual({ id: expect.stringMatching(/^[0-9a-f]{32}-1$/), release: [p.taker.hash, p.makers[0].hash] });
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a MarketMismatch the node reports is handled the same way', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({ revert: { name: 'MarketMismatch', args: [`0x${'ab'.repeat(32)}`] } });
      await drive(mk(sql), prop('directTakerBuy', ['directMakerSell']));
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('match_abandoned');
    });
  });
});

describe('one match at a time (plan 6.2)', () => {
  it('simulates only after the previous transaction\'s receipt: while one is in flight nothing is simulated', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ pending: true });
      const s = mk(sql);
      await drive(s, prop('directTakerBuy', ['directMakerSell']), 1);
      const traces = () => r.w.calls.filter((c) => c.method === 'debug_traceCall').length;
      expect(traces()).toBe(1);
      expect(await s.submit(prop('directTakerBuy', ['directMakerSell']))).toEqual({ accepted: false, reason: 'busy' });
      await s.run();
      await s.run();
      expect(traces()).toBe(1);
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('two markets sharing one maker\'s cash give one fill and one uncounted drop', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('directTakerBuy', ['directMakerSell']);
      // the first proposal simulates clean; by the second the shared cash is gone
      r.w.sim = () => (r.outcomes.length === 0 ? {} : { revert: { name: 'InsufficientCash', args: [p.taker.hash] } });
      const s = mk(sql);
      await drive(s, p);
      await drive(s, p);
      expect(r.w.sent).toHaveLength(1);
      expect(r.outcomes[0].body.applied).toHaveLength(2);
      expect(r.outcomes[1].body.dropped).toEqual([{ hash: p.taker.hash, reason: 'insufficient_cash' }]);
      expect(failures(sql)).toEqual([]);
    });
  });
});
