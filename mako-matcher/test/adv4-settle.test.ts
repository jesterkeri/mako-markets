// Fourth adversary round, settler side of the in-flight marks (brief "In-flight orders": every order of a proposal
// the settler accepted is in flight until the settler reports its outcome; GET /held is what keeps a market from
// releasing a mark the settler still owes an outcome for).
import { describe, expect, it } from 'vitest';
import { heldHashes } from '../src/settler';
import { utcDay } from '../src/settle';
import { drive, prop, rows, withSettler } from './settle-helpers';
import { V } from './vectors';

describe('adversary 4: /held names every order the settler still owes an outcome for', () => {
  it('a party left out of the transaction in flight (dropped while the match was rebuilt) is still held', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.addSafe(V.safes.safeTaker.address, V.safes.safeTaker.ownerAddress);
      r.w.addSafe(V.safes.safeMaker1.address, V.safes.safeMaker1.ownerAddress);
      // two makers; the first maker's account is refused for the day after acceptance, so the settler rebuilds without it
      const p = prop('directTakerBuy', ['safeMakerSell', 'direct3Maker1Sell'], ['50000000', '50000000'], '100000000');
      // refused after the settler accepted the proposal (since Codex MATCHER R5 F1 a party refused before is not accepted)
      const s = mk(sql);
      expect(await s.submit(p)).toEqual({ accepted: true });
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', p.makers[0].order.maker, utcDay(r.w.nowMs), 'bad_signature', 1);
      // the node never mines it: the transaction stays in flight
      r.w.onSend = () => ({ pending: true });
      await drive(s, null);
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM in_flight')[0]).toEqual({ n: 1 });
      expect(r.outcomes).toEqual([]); // nothing reported: the market still has all three orders marked
      const held = heldHashes(sql);
      expect(held).toContain(p.taker.hash);
      expect(held).toContain(p.makers[1].hash);
      expect(held, 'the dropped maker is marked in flight in the market until the outcome reports it').toContain(p.makers[0].hash);
    });
  });
});
