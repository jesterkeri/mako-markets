// The plan 6.2 revert table, one test per error and per place it is found (simulation, or a sent transaction).
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { encodeCall } from '../src/abi';
import { toTuple } from '../src/encode';
import { DIRECT, drive, prop, rows, SAFE_MATCH, withSettler } from './settle-helpers';
import { OP, type Rig } from './settle-world';
import { V } from './vectors';

const P = DIRECT();
const T = P.taker.hash;
const M = P.makers[0].hash;
const MAKER = P.makers[0].order.maker;
const failures = (sql: SqlStorage) => rows<{ n: number }>(sql, 'SELECT n FROM failures');
const refused = (sql: SqlStorage) => rows<{ maker: string }>(sql, 'SELECT maker FROM refused_accounts');

type Row = { name: string; args?: unknown[]; dropped?: { hash: Hex; reason: string }[]; stop?: boolean; closed?: boolean; abandon?: boolean };

// [error, args, what the settler reports]
const TABLE: Row[] = [
  { name: 'NotOperator' },
  { name: 'Paused' },
  { name: 'TradingClosed', closed: true },
  { name: 'InsufficientGas' },
  { name: 'NonceMismatch', args: [M], dropped: [{ hash: M, reason: 'nonce' }] },
  { name: 'OrderCancelled', args: [T], dropped: [{ hash: T, reason: 'cancelled' }] },
  { name: 'Expired', args: [M], dropped: [{ hash: M, reason: 'expired' }] },
  { name: 'Overfill', args: [M], dropped: [{ hash: M, reason: 'overfill' }] },
  { name: 'PartyRefused', args: [T], dropped: [{ hash: T, reason: 'partyrefused' }] },
  { name: 'SelfMatch', abandon: true },
  { name: 'PriceNotCrossed', abandon: true },
  { name: 'WrongKind', abandon: true },
  { name: 'BadMakerCount', abandon: true },
  { name: 'LengthMismatch', abandon: true },
  { name: 'BadSignatureLength', args: [M], abandon: true },
  { name: 'FillMismatch', abandon: true },
  { name: 'SetPriceSum', abandon: true },
  { name: 'BadOrderField', args: [M], abandon: true },
  { name: 'MarketMismatch', args: [M], abandon: true },
  { name: 'InsufficientCash', args: [M], dropped: [{ hash: M, reason: 'insufficient_cash' }] },
  { name: 'InsufficientShares', args: [T], dropped: [{ hash: T, reason: 'insufficient_shares' }] },
  { name: 'PositionCap', args: [M], dropped: [{ hash: M, reason: 'position_cap' }] },
];

function expectOutcome(r: Rig, row: Row, sent: boolean) {
  expect(r.outcomes).toHaveLength(1);
  const o = r.outcomes[0].body;
  expect(o.release).toEqual([T, M]);
  expect(o.applied).toBeUndefined();
  if (row.name === 'InsufficientGas' && sent) {
    expect(o.stopMarket).toMatch(/gate G-T|no trace|ran out of gas/);
    return;
  }
  expect(o.stopMarket).toBeUndefined();
  expect(o.dropped ?? []).toEqual(row.dropped ?? []);
  if (row.closed) expect(o.closed).toBe(true);
  else expect(o.closed).toBeUndefined();
  if (row.abandon) expect(r.alerts.map((a) => a.code)).toContain('match_abandoned');
}

describe('found in the simulation: nothing is sent, nothing is counted', () => {
  for (const row of TABLE) {
    it(row.name, async () => {
      await withSettler(async (sql, r, mk) => {
        r.w.sim = () => ({ revert: { name: row.name, args: row.args } });
        await drive(mk(sql), DIRECT());
        expect(r.w.sent).toEqual([]);
        expect(failures(sql)).toEqual([]);
        expect(refused(sql)).toEqual([]);
        expectOutcome(r, row, false);
      });
    });
  }

  it('InsufficientGas holds and alerts on the third in a row', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({ revert: { name: 'InsufficientGas' } });
      const s = mk(sql);
      await drive(s, DIRECT());
      await drive(s, DIRECT());
      expect(r.alerts.map((a) => a.code)).not.toContain('insufficient_gas_streak');
      await drive(s, DIRECT());
      expect(r.alerts.map((a) => a.code)).toContain('insufficient_gas_streak');
    });
  });
});

describe('the InsufficientGas streak', () => {
  it('a clean simulation ends the streak: two, a clean one, two more never alert', async () => {
    await withSettler(async (sql, r, mk) => {
      let ig = true;
      r.w.sim = () => (ig ? { revert: { name: 'InsufficientGas' } } : {});
      const s = mk(sql);
      await drive(s, DIRECT());
      await drive(s, DIRECT());
      ig = false;
      await drive(s, DIRECT());
      ig = true;
      await drive(s, DIRECT());
      await drive(s, DIRECT());
      expect(r.alerts.map((a) => a.code)).not.toContain('insufficient_gas_streak');
    });
  });
});

describe('found in a SENT transaction: read from its own trace', () => {
  for (const row of TABLE) {
    it(row.name, async () => {
      await withSettler(async (sql, r, mk) => {
        r.w.onSend = () => ({ revert: { name: row.name, args: row.args } });
        await drive(mk(sql), DIRECT());
        expect(r.w.sent).toHaveLength(1);
        expectOutcome(r, row, true);
        expect(rows(sql, 'SELECT status FROM send_log')).toEqual([{ status: 'reverted' }]);
      });
    });
  }

  it('a sent InsufficientCash counts once, and the account is refused only at the third', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'InsufficientCash', args: [M] } });
      const s = mk(sql);
      await drive(s, DIRECT());
      await drive(s, DIRECT());
      expect(failures(sql)).toEqual([{ n: 2 }]);
      expect(refused(sql)).toEqual([]);
      expect(r.outcomes.at(-1)!.body.refusedMakers).toBeUndefined();
      await drive(s, DIRECT());
      expect(failures(sql)).toEqual([{ n: 3 }]);
      expect(refused(sql)).toEqual([{ maker: MAKER }]);
      expect(r.outcomes.at(-1)!.body.refusedMakers).toEqual([MAKER]);
    });
  });

  it('an error read in simulation never counts, however often it happens', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({ revert: { name: 'InsufficientCash', args: [M] } });
      const s = mk(sql);
      for (let i = 0; i < 5; i++) await drive(s, DIRECT());
      expect(failures(sql)).toEqual([]);
      expect(refused(sql)).toEqual([]);
    });
  });

  it('a nonce bump or an on-chain cancel found in a sent transaction never counts', async () => {
    await withSettler(async (sql, r, mk) => {
      for (const name of ['NonceMismatch', 'OrderCancelled']) {
        r.w.onSend = () => ({ revert: { name, args: [M] } });
        await drive(mk(sql), DIRECT());
      }
      expect(failures(sql)).toEqual([]);
      expect(refused(sql)).toEqual([]);
    });
  });

  it('a stranded NotOperator call is reported, its orders go back to the book, and nothing stops', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'NotOperator' } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.stopMarket).toBeUndefined();
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      r.w.onSend = () => ({ status: 1 });
      await drive(mk(sql), DIRECT());
      expect(r.w.sent).toHaveLength(2);
    });
  });

  it('with no trace readable the market stops and nothing is dropped, counted or re-sent', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'InsufficientCash', args: [M] }, noTrace: true });
      const s = mk(sql);
      await drive(s, DIRECT());
      expect(r.outcomes[0].body.stopMarket).toMatch(/trace could not be read/);
      expect(r.outcomes[0].body.dropped).toEqual([]);
      expect(failures(sql)).toEqual([]);
      expect(r.alerts.map((a) => a.code)).toContain('no_trace');
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('the error comes from the mined transaction, not from a replayed call: the simulation passed and the trace says otherwise', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({}); // every replay is clean
      r.w.onSend = () => ({ revert: { name: 'PartyRefused', args: [T] } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: T, reason: 'partyrefused' }]);
    });
  });

  it('an unrecognised revert (a panic) stops the market', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'Reentrancy' } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.stopMarket).toMatch(/unrecognised revert \(Reentrancy\)/);
      expect(r.alerts.map((a) => a.code)).toContain('unknown_revert');
    });
  });
});

describe('BadSignature: blame comes from bytes (plan 6.2)', () => {
  it('found in simulation with the pair equal to the stored record: the order is dropped and not counted', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.sim = () => ({ revert: { name: 'BadSignature', args: [M] } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: M, reason: 'bad_signature' }]);
      expect(failures(sql)).toEqual([]);
      expect(r.w.sent).toEqual([]);
    });
  });

  it('the gas-price-gated maker: the simulation passes, the sent call reverts BadSignature, the pair is equal: dropped, counted once, the account refused for the day, and no second settlement with it', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'BadSignature', args: [M] } });
      const s = mk(sql);
      await drive(s, DIRECT());
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: M, reason: 'bad_signature' }]);
      expect(r.outcomes[0].body.refusedMakers).toEqual([MAKER]);
      expect(failures(sql)).toEqual([{ n: 1 }]);
      expect(refused(sql)).toEqual([{ maker: MAKER }]);
      // the same maker's other order tried again the same day: nothing is sent
      r.w.sent.length = 0;
      r.w.onSend = () => ({ status: 1 });
      const before = r.outcomes.length;
      // since Codex MATCHER R5 F1 the settler does not accept it at all (before: accepted, then dropped as refused)
      expect(await drive(s, prop('directTakerBuy', ['directMakerSell']))).toEqual({ accepted: false, reason: 'party_refused' });
      expect(r.w.sent).toEqual([]);
      expect(r.outcomes).toHaveLength(before);
    });
  });

  it('a sent call whose pair differs from the stored record (a signature at the wrong index) stops the market and drops and counts nothing', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('direct3TakerBuy', ['direct3Maker1Sell', 'direct3Maker2Sell']);
      r.w.onSend = () => ({ revert: { name: 'BadSignature', args: [p.makers[0].hash] } });
      // the node reports an input with the two maker signatures swapped
      r.w.inputOverride = (input) => input.replace(p.makers[0].signature.slice(2), 'AAAA').replace(p.makers[1].signature.slice(2), p.makers[0].signature.slice(2)).replace('AAAA', p.makers[1].signature.slice(2)) as Hex;
      await drive(mk(sql), p);
      expect(r.outcomes[0].body.stopMarket).toMatch(/differs from the stored record/);
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a call carrying the same order hash at two indices where only the second signature differs also stops the market', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('direct3TakerBuy', ['direct3Maker1Sell', 'direct3Maker2Sell']);
      r.w.onSend = () => ({ revert: { name: 'BadSignature', args: [p.makers[1].hash] } });
      // the second maker's order appears at two indices, the second time with another signature
      r.w.inputOverride = () => {
        const o1 = toTuple(p.makers[1].order);
        return encodeCall('matchOrders', [toTuple(p.taker.order), p.taker.signature, [o1, o1], [p.makers[1].signature, p.makers[0].signature], [100000000n, 100000000n], 200000000n]);
      };
      await drive(mk(sql), p);
      expect(r.outcomes[0].body.stopMarket).toBeDefined();
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a BadSignature with no hash in the call stops the market', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'BadSignature', args: [`0x${'ab'.repeat(32)}`] } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.stopMarket).toBeDefined();
    });
  });
});

describe('out of gas in a sent transaction (plan 6.2, rules 1 to 5)', () => {
  const EVIL = `0x${'ee'.repeat(20)}` as Hex;
  function safes(r: Rig) {
    r.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
    r.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
  }

  it('with gate G-T passed, only the party whose check frame ran code outside the allowlist is blamed, counted once and refused; the honest Safe stays', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      r.over.gateGt = true;
      const p = SAFE_MATCH();
      r.w.onSend = () => ({ oog: true, extraRan: [EVIL], extraFor: p.makers[0].order.maker });
      await drive(mk(sql), p);
      expect(r.w.sent).toHaveLength(1);
      expect(r.outcomes[0].body.dropped).toEqual([{ hash: p.makers[0].hash, reason: 'out_of_gas_blame' }]);
      expect(r.outcomes[0].body.refusedMakers).toEqual([p.makers[0].order.maker]);
      expect(failures(sql)).toEqual([{ n: 1 }]);
      expect(refused(sql)).toEqual([{ maker: p.makers[0].order.maker }]);
      expect(r.outcomes[0].body.stopMarket).toBeUndefined();
    });
  });

  it('without gate G-T every sent out-of-gas stops the market and nothing is dropped, counted or re-sent', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      const p = SAFE_MATCH();
      r.w.onSend = () => ({ oog: true, extraRan: [EVIL], extraFor: p.makers[0].order.maker });
      const s = mk(sql);
      await drive(s, p);
      expect(r.outcomes[0].body.stopMarket).toMatch(/gate G-T has not passed/);
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      expect(failures(sql)).toEqual([]);
      expect(r.w.sent).toHaveLength(1);
    });
  });

  it('with the gate passed but every check frame allowlisted, no party can be named: the market stops', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      r.over.gateGt = true;
      r.w.onSend = () => ({ oog: true });
      await drive(mk(sql), SAFE_MATCH());
      expect(r.outcomes[0].body.stopMarket).toMatch(/no party/);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a call of EOAs only (the limit lowered): the market stops, nothing is dropped or counted, nothing is re-sent', async () => {
    await withSettler(async (sql, r, mk) => {
      r.over.gateGt = true;
      r.w.onSend = () => ({ oog: true });
      const s = mk(sql);
      await drive(s, DIRECT());
      expect(r.outcomes[0].body.stopMarket).toBeDefined();
      expect(r.outcomes[0].body.dropped ?? []).toEqual([]);
      expect(r.w.sent).toHaveLength(1);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('with the trace unreachable the market stops, and nothing is dropped, counted or re-sent', async () => {
    await withSettler(async (sql, r, mk) => {
      safes(r);
      r.over.gateGt = true;
      r.w.onSend = () => ({ oog: true, noTrace: true });
      await drive(mk(sql), SAFE_MATCH());
      expect(r.outcomes[0].body.stopMarket).toBeDefined();
      expect(r.w.sent).toHaveLength(1);
      expect(failures(sql)).toEqual([]);
    });
  });

  it('a sent InsufficientGas is handled as out of gas, never held and re-simulated', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'InsufficientGas' } });
      await drive(mk(sql), DIRECT());
      expect(r.outcomes[0].body.stopMarket).toBeDefined();
    });
  });
});

void OP;
