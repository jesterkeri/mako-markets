// Codex MATCHER R7. F1: the first dated read of a book (no cursor yet) must reach back to an exclusion day whose
// one-minute slack covers a booked order, even when that read is the crossing intake's own pass. F2: an exclusion
// written while a market's read is in flight, then carried across midnight, must still stop the old order at the
// settler, which checks each order's booking time against every exclusion row. F3: intake must not say "booked" for
// an order its own pass removed.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { DAY_EDGE_SLACK_MS } from '../src/config';
import type { Env } from '../src/env';
import { handoffAnswer } from '../src/market';
import { MatcherSettler } from '../src/settler';
import { utcDay } from '../src/settle';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';
import { DIRECT, rows, withSettler } from './settle-helpers';

const M = vec('directMakerSell').order.maker.toLowerCase() as Hex;

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function place(name: string) {
  const v = vec(name);
  fund(h.w, v.order, 500_000_000n);
  return h.place(v);
}
const ordersOf = async (maker: Hex) => (await h.sql<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, maker))[0].n;
const nextDay = () => (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
const namesM = () => h.settled.filter((b) => JSON.stringify(b).toLowerCase().includes(M));

/// A settler whose clock runs `skew` ms behind the market's, holding dated rows.
function skewedSettler(skew: number) {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const table: { maker: Hex; day: string }[] = [];
  h.deps.refusalsSince = async (since) => table.filter((r) => r.day >= since && r.day <= day(h.w.nowMs - skew));
  return { table, settlerDay: () => day(h.w.nowMs - skew) };
}

describe('Codex R7 F1: the first dated read of a fresh book covers the slack', () => {
  it('crossing intake before any tick: the order booked in the skew window is dropped and never handed over', async () => {
    const s = skewedSettler(2_000);
    h.w.nowMs = nextDay() + 500; // market just past midnight, settler still on D
    expect((await place('directMakerSell')).status).toBe(200); // no crossing order: no read yet
    s.table.push({ maker: M, day: s.settlerDay() }); // excluded for D
    h.w.nowMs += 5_000; // both clocks on D+1
    await place('directTakerBuy'); // the pass's first dated read
    expect(namesM(), 'never handed over').toHaveLength(0);
    expect(await ordersOf(M), 'dropped').toBe(0);
  });

  it('the first read on a tick with no crossing order drops it too', async () => {
    const s = skewedSettler(2_000);
    h.w.nowMs = nextDay() + 500;
    await place('directMakerSell');
    s.table.push({ maker: M, day: s.settlerDay() });
    h.w.nowMs += 5_000;
    await h.tick();
    expect(await ordersOf(M)).toBe(0);
  });

  it('after the book is emptied and its cursor cleared, the next first read still reaches back', async () => {
    const s = skewedSettler(2_000);
    await place('directMakerSell');
    await h.tick(); // a read: the cursor is set
    await h.sql(`DELETE FROM orders`);
    await h.tick(); // empty book: cursor cleared
    expect(await h.sql(`SELECT v FROM meta WHERE k = 'refusals_since'`)).toEqual([]);
    h.w.nowMs = nextDay() + 500;
    await place('directMakerSell');
    s.table.push({ maker: M, day: s.settlerDay() });
    h.w.nowMs += 5_000;
    await place('directTakerBuy');
    expect(namesM()).toHaveLength(0);
    expect(await ordersOf(M)).toBe(0);
  });

  it('control: an order booked after the slack is kept and handed over', async () => {
    const s = skewedSettler(2_000);
    h.w.nowMs = nextDay() - 10_000;
    s.table.push({ maker: M, day: s.settlerDay() }); // excluded for D
    h.w.nowMs = nextDay() + DAY_EDGE_SLACK_MS; // D+1, past the slack
    h.settleAccepts = true;
    await place('directMakerSell');
    await place('directTakerBuy');
    expect(namesM()).toHaveLength(1);
  });
});

describe('Codex R7 F2: an exclusion written during a held read, carried across midnight, is enforced by the settler', () => {
  const configured: Partial<Env> = { K: '5', FUNDER_ADDRESS: '0x' + 'f0'.repeat(20), OPERATOR_PRIVATE_KEY: generatePrivateKey() };
  const stub = () => env.SETTLER.get(env.SETTLER.idFromName('settler-r7'));
  const viaRealSettler = (answers: number[]) => {
    h.deps.settle = async (body) =>
      runInDurableObject(stub(), async (_i, state) => {
        const res = await new MatcherSettler(state, { ...env, ...configured } as Env).fetch(
          new Request('https://settler/settle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        );
        answers.push(res.status);
        return handoffAnswer(await res.text());
      });
  };
  const cleanup = () =>
    runInDurableObject(stub(), async (_i, state) => {
      for (const t of ['refused_accounts', 'pending']) state.storage.sql.exec(`DELETE FROM ${t}`);
      await state.storage.deleteAlarm();
    });

  it('the held snapshot omits M; M is excluded for D; both clocks turn; the real submit refuses and nothing is pending; the order is dropped later', async () => {
    const answers: number[] = [];
    viaRealSettler(answers);
    h.w.nowMs = nextDay() - 30_000; // D, 23:59:30
    const D = utcDay(h.w.nowMs);
    await place('directMakerSell');
    const inner = h.deps.refusalsSince;
    let held = true;
    h.deps.refusalsSince = async (since) => {
      const snapshot = await inner(since); // captured without M
      if (held) {
        held = false;
        await runInDurableObject(stub(), (_i, state) => {
          state.storage.sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', M, D, 'bad_signature', 1);
        });
        h.refusedEarlier.push({ maker: M, day: D }); // what the market's next read will see
        h.w.nowMs = nextDay() + 5_000; // D+1 for both
      }
      return snapshot;
    };
    try {
      const r = await place('directTakerBuy');
      expect(answers, 'handed over once, refused').toEqual([503]);
      expect(r.json).toMatchObject({ handoff: 'refused' });
      await runInDurableObject(stub(), (_i, state) => {
        expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM pending').one().n).toBe(0);
      });
      await h.tick();
      expect(await ordersOf(M), 'dropped by the next read').toBe(0);
      expect(answers).toEqual([503]);
    } finally {
      await cleanup();
    }
  });

  it('control: a new order M books after the slack on D+1 is accepted by the real settler despite the D row', async () => {
    const answers: number[] = [];
    viaRealSettler(answers);
    h.w.nowMs = nextDay() - 30_000;
    const D = utcDay(h.w.nowMs);
    try {
      await runInDurableObject(stub(), (_i, state) => {
        state.storage.sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', M, D, 'bad_signature', 1);
      });
      h.refusedEarlier.push({ maker: M, day: D });
      h.w.nowMs = nextDay() + DAY_EDGE_SLACK_MS;
      await place('directMakerSell');
      await place('directTakerBuy');
      expect(answers).toEqual([200]);
    } finally {
      await cleanup();
    }
  });

  it('settler processing: a proposal accepted on D, M excluded for D afterwards, run on D+1: nothing is sent and M is dropped as refused', async () => {
    await withSettler(async (sql, r, mk) => {
      const end = (Math.floor(r.w.nowMs / 86_400_000) + 1) * 86_400_000;
      r.w.nowMs = end - 1_000;
      const p = DIRECT();
      for (const x of [p.taker, ...p.makers]) x.bookedAt = end - 2_000;
      const s = mk(sql);
      expect(await s.submit(p)).toEqual({ accepted: true });
      sql.exec('INSERT INTO refused_accounts (maker, utc_day, reason, at) VALUES (?, ?, ?, ?)', p.makers[0].order.maker, utcDay(r.w.nowMs), 'x', 1);
      r.w.nowMs = end + 5_000;
      for (let i = 0; i < 3; i++) await s.run();
      expect(r.w.sent, 'nothing sent').toHaveLength(0);
      expect(rows(sql, 'SELECT COUNT(*) AS n FROM pending')[0]).toEqual({ n: 0 });
      const out = r.outcomes.map((o) => o.body);
      expect(JSON.stringify(out)).toContain('refused');
    });
  });
});

describe('Codex R7 F3: intake answers truthfully when its own pass removed the new order', () => {
  it('inside the slack on D+1 with a D exclusion and a crossing book: 400 account_refused, and the order is not stored', async () => {
    const D = utcDay(nextDay() - 1);
    h.w.nowMs = nextDay() - 60_000;
    await place('directTakerBuy'); // the crossing side, another account
    h.refusedEarlier.push({ maker: M, day: D });
    h.w.nowMs = nextDay() + 10_000; // inside the slack; intake's today-check passes
    const r = await place('directMakerSell');
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, code: 'account_refused' });
    expect(await ordersOf(M)).toBe(0);
    expect(namesM()).toHaveLength(0);
  });

  it('control: after the slack the same order is booked and the response says so', async () => {
    const D = utcDay(nextDay() - 1);
    h.w.nowMs = nextDay() - 60_000;
    await place('directTakerBuy');
    h.refusedEarlier.push({ maker: M, day: D });
    h.w.nowMs = nextDay() + DAY_EDGE_SLACK_MS;
    const r = await place('directMakerSell');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, booked: true });
    expect(await ordersOf(M)).toBe(1);
  });
});
