// Adversary 13, attacks on Codex MATCHER R5 F1 (the settler's submit refuses a hand-off naming an account refused
// today). Real settler Durable Object storage, the shared settle world; the market side uses the harness.
import { beforeEach, describe, expect, it } from 'vitest';
import { utcDay } from '../src/settle';
import { handoffAnswer } from '../src/market';
import { heldHashes } from '../src/settler';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';
import { prop, rows, withSettler } from './settle-helpers';

const DIRECT = () => prop('directTakerBuy', ['directMakerSell']);
const MAKER = DIRECT().makers[0].order.maker;

describe('adv13: settler side', () => {
  it('a mint whose LAST maker is refused today is not accepted', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = prop('mintTakerBuy0', ['safeMakerSell', 'mintMakerBuy2'], ['100000000', '100000000'], '100000000', 'mint');
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', p.makers[1].order.maker, utcDay(r.w.nowMs), 'x', 1);
      const s = mk(sql);
      expect(await s.submit(p)).toEqual({ accepted: false, reason: 'party_refused' });
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')[0]).toEqual({ n: 0 });
      expect(heldHashes(sql)).toEqual([]);
    });
  });

  it('UTC day edge: refused at 23:59:59.999 of day D is refused; the same row is not a refusal at 00:00:00.000 of D+1', async () => {
    await withSettler(async (sql, r, mk) => {
      const p = DIRECT();
      const dayStart = Math.floor(r.w.nowMs / 86_400_000) * 86_400_000;
      r.w.nowMs = dayStart + 86_400_000 - 1;
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', MAKER, utcDay(r.w.nowMs), 'x', 1);
      const s = mk(sql);
      expect(await s.submit(p)).toEqual({ accepted: false, reason: 'party_refused' });
      r.w.nowMs += 1;
      expect(await s.submit(p)).toEqual({ accepted: true });
    });
  });

  it('interleaving: a submit while the alarm is mid-settlement (which then refuses the maker) is busy; a retry after is party_refused, never accepted', async () => {
    await withSettler(async (sql, r, mk) => {
      r.w.onSend = () => ({ revert: { name: 'BadSignature', args: [DIRECT().makers[0].hash] } });
      const s = mk(sql);
      expect(await s.submit(DIRECT())).toEqual({ accepted: true });
      const running = s.run(); // suspended at its first await
      expect(await s.submit(DIRECT())).toEqual({ accepted: false, reason: 'busy' });
      await running;
      for (let i = 0; i < 3; i++) await s.run();
      expect(rows(sql, 'SELECT maker FROM refused_accounts')).toEqual([{ maker: MAKER }]);
      expect(await s.submit(DIRECT())).toEqual({ accepted: false, reason: 'party_refused' });
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')[0]).toEqual({ n: 0 });
    });
  });

  // A parser test on a literal body; the real configured route is tested in handoff-answer.test.ts (Codex MATCHER R6 F3).
  it('handoffAnswer parses a party_refused body as an explicit refusal', () => {
    expect(handoffAnswer('{"ok":false,"accepted":false,"error":"party_refused"}')).toEqual({ accepted: false });
  });
});

describe('adv13: market side', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await fresh('1');
  });

  it('a TAKER refused after the read: refused, marks released, and no mark left after many ticks', async () => {
    h.settlerChecksRefusals = true; // the fake settler applies settle.ts submit's rule
    fund(h.w, vec('direct3Maker1Sell').order, 500_000_000n);
    await h.place(vec('direct3Maker1Sell'));
    const inner = h.deps.refusedList;
    let done = false;
    h.deps.refusedList = async () => {
      const s = await inner();
      if (!done) {
        done = true;
        h.refused.add(vec('directTakerBuy').order.maker.toLowerCase());
      }
      return s;
    };
    fund(h.w, vec('directTakerBuy').order, 500_000_000n);
    await h.place(vec('directTakerBuy'));
    for (let i = 0; i < 10; i++) await h.tick();
    expect(h.settled).toHaveLength(0);
    expect(h.refusedHandoffs.length).toBeGreaterThan(0);
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE in_flight = 1`))[0].n).toBe(0);
  });

  it('control for the harness: by default the fake settler does not check the list, so a market blind to it shows up in `settled`', async () => {
    fund(h.w, vec('directMakerSell').order, 500_000_000n);
    await h.place(vec('directMakerSell'));
    h.refused.add(vec('directMakerSell').order.maker.toLowerCase());
    h.deps.refusedList = async () => new Set();
    fund(h.w, vec('directTakerBuy').order, 500_000_000n);
    await h.place(vec('directTakerBuy'));
    // adversary R13: when the fake diverted every refused hand-off, a test asserting only `settled` empty passed though the
    // market proposed the refused account; the check is now opt-in (`settlerChecksRefusals`)
    expect(h.settled).toHaveLength(1);
    expect(h.refusedHandoffs).toEqual([]);
  });
});
