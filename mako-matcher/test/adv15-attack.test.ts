// Adversary R15 on b53c3e5 (all three failed there; fixed: the tick and every matching pass read the dated refusals,
// drop what they cover and match nothing when unreadable; the next read starts a day back). Plan 6.2: an account refused for a UTC day has the orders it had booked by the end of that
// day dropped as refused, and they never become matchable again (matcher brief; requirement 1 and 3).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const M = vec('directMakerSell').order.maker;

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
const namesM = () => h.settled.filter((b) => JSON.stringify(b).toLowerCase().includes(M.toLowerCase()));

describe('adversary R15: a refused account is handed off on the new day', () => {
  it('the refusal read fails on the new day (at b53c3e5 the day list still read): the tick must not propose the refused account', async () => {
    // book both sides with no hand-off (the list read fails closed during booking)
    const okList = h.deps.refusalsSince;
    h.deps.refusalsSince = async () => {
      throw new Error('down');
    };
    await place('directMakerSell');
    await place('directTakerBuy');
    h.deps.refusalsSince = okList;
    expect(h.settled).toHaveLength(0);
    h.refused.add(M); // refused for today (another market's failed settlement)
    h.turnDay(nextDay() + 1_000); // new day: the settler's day list no longer names it, yesterday's row stays
    h.deps.refusalsSince = async () => {
      throw new Error('settler error on the dated read only');
    };
    await h.tick();
    expect(namesM(), 'refused the day before: its order must never be handed off').toHaveLength(0);
  });

  it('no tick between the refusal and the new day: the next order that crosses it hands it off', async () => {
    await place('directMakerSell');
    h.refused.add(M); // refused, the market has not ticked yet
    h.turnDay(nextDay() + 1_000);
    await place('directTakerBuy'); // intake's matching pass: today's list is empty
    expect(namesM(), 'refused the day before: must not be handed off').toHaveLength(0);
    expect(await ordersOf(M)).toBe(0);
  });

  it('clock skew: the settler is 2 s behind the market, so its refusal row carries the day the market has already left', async () => {
    const okList = h.deps.refusalsSince;
    h.deps.refusalsSince = async () => {
      throw new Error('down');
    };
    await place('directMakerSell');
    h.deps.refusalsSince = okList;
    const skew = 2_000;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rows: { maker: Hex; day: string }[] = [];
    h.deps.refusalsSince = async (since) => {
      const today = day(h.w.nowMs - skew); // the settler's own clock
      return rows.filter((r) => r.day >= since && r.day <= today).map((r) => ({ maker: r.maker, day: r.day }));
    };
    h.turnDay(nextDay() + 500); // market clock: 00:00:00.5 of the new day; settler clock: still the old day
    await h.tick(); // good read, nothing yet: the market records its own day
    rows.push({ maker: M, day: day(h.w.nowMs - skew) }); // the settler refuses M, stamped with ITS day (the old one)
    h.w.nowMs += 1_000;
    await h.tick();
    h.w.nowMs += 5_000; // the settler's clock has now turned too
    await h.tick();
    expect(await ordersOf(M), 'refused on the day its order was booked: must be dropped').toBe(0);
  });
});
