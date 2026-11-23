// Adversary R14 on a2981ac (failed there; fixed by dated refusal reads and the in-flight refused flag): plan 6.2 says an account refused for the UTC day has its booked orders dropped as refused,
// and the matcher brief says they must not become matchable again at the next UTC day. The drop reads the settler's
// list of TODAY at each tick, and the list forgets the account at midnight. An order the drop had to skip (in flight,
// or the list unreadable) therefore comes back on the new day.
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

describe('adversary R14: the UTC day turns while a refused account still has an order the drop skipped', () => {
  it('in flight when refused, its outcome (not naming it) arrives after midnight: the order is dropped, not matchable on the new day', async () => {
    await place('directMakerSell');
    h.settleAccepts = true;
    await place('directTakerBuy'); // direct pair handed off and accepted: both in flight
    const pair = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    h.held = pair;
    h.refused.add(M); // refused (another market's failed settlement), before midnight
    await h.tick();
    expect(await ordersOf(M), 'in flight: kept').toBe(1);

    h.turnDay(nextDay() + 1_000); // the new day: the settler's list no longer names it (yesterday's row stays)
    h.held = [];
    // the settler reports on the proposal; it settled nothing and blames nobody (a release only)
    expect((await h.call('POST', '/outcome', { body: { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-1', release: pair } })).status).toBe(200);
    await h.tick();
    expect(await ordersOf(M), 'refused for the day, in flight at the time: must be dropped once released').toBe(0);
  });

  it('the settler is unreadable from before midnight until after it: the refused account comes back on the new day', async () => {
    await place('directMakerSell');
    h.refused.add(M);
    h.settlerDown = true;
    await h.tick(); // list unreadable: kept, alerted
    h.turnDay(nextDay() + 1_000); // the new day's list is empty; yesterday's row stays in the settler's table
    h.settlerDown = false;
    await h.tick();
    expect(await ordersOf(M), 'refused the day before: must not be matchable now').toBe(0);
  });

  it('held by the settler across a later good read (which no longer returns the refusal day): still dropped once released', async () => {
    await place('directMakerSell');
    h.settleAccepts = true;
    await place('directTakerBuy');
    const pair = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    h.held = pair;
    h.refused.add(M);
    await h.tick(); // refused while in flight: flagged
    h.turnDay(nextDay() + 1_000);
    await h.tick(); // good read on the new day: the next read starts from today
    h.turnDay(nextDay() + 1_000);
    await h.tick(); // a further day: the refusal day is no longer read back
    expect(await ordersOf(M), 'still in flight').toBe(1);
    h.held = [];
    expect((await h.call('POST', '/outcome', { body: { id: 'cccccccccccccccccccccccccccccccc-1', release: pair } })).status).toBe(200);
    expect(await ordersOf(M), 'dropped as refused at release').toBe(0);
  });
});
