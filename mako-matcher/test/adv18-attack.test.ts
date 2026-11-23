// Adversary R18 on ffcfcc0 (failed there; fixed: intake watches its order for a refusal drop by any pass). Req 4: POST /orders answers `booked` truthfully, including when another event (the
// alarm tick) removes the new order while intake's own matching pass is awaiting the chain.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { handleAlarm } from '../src/market';
import { utcDay } from '../src/settle';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

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

describe('adversary R18: intake answers booked for an order another pass removed while its own pass awaited', () => {
  it("the alarm tick drops the new order (excluded for D, inside the slack) during intake's role read: the answer must not say booked", async () => {
    const D = utcDay(nextDay() - 1);
    h.w.nowMs = nextDay() - 60_000;
    await place('directTakerBuy'); // crossing side, another account
    h.refusedEarlier.push({ maker: M, day: D });
    h.w.nowMs = nextDay() + 10_000; // inside the slack; intake's today-check passes

    // arm: after intake's own checks and insert, the next chain read of the pass runs one alarm tick, as the runtime
    // may do while the intake awaits I/O
    const innerToday = h.deps.refusedToday;
    const innerFetch = h.deps.fetch;
    let armed = false;
    let ticked = false;
    h.deps.refusedToday = async (m) => {
      const r = await innerToday(m);
      armed = true;
      return r;
    };
    h.deps.fetch = async (i, x) => {
      if (armed && !ticked) {
        ticked = true;
        await handleAlarm(h.state!, env, h.deps);
      }
      return innerFetch(i, x);
    };
    const r = await place('directMakerSell');
    expect(ticked, 'the tick ran during the pass').toBe(true);
    expect(await ordersOf(M), 'the order is not in storage').toBe(0);
    expect(r.json, 'the answer must match storage').not.toMatchObject({ ok: true, booked: true });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, code: 'account_refused' });
  });

  it('removed meanwhile for another reason (a cancel seen by another request): ok, but booked false', async () => {
    await place('directTakerBuy');
    const innerFetch = h.deps.fetch;
    let removed = false;
    h.deps.fetch = async (i, x) => {
      // the first chain read after the new order is stored (inside intake's matching pass); the object's own storage,
      // as a concurrent request in this live instance would change it
      const sql = h.state!.storage.sql;
      if (!removed && sql.exec<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE maker = ?`, M).one().n > 0) {
        removed = true;
        sql.exec(`DELETE FROM orders WHERE maker = ?`, M);
      }
      return innerFetch(i, x);
    };
    const r = await place('directMakerSell');
    expect(removed).toBe(true);
    expect(await ordersOf(M)).toBe(0);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, booked: false });
  });
});
