// Adversary R16 on 9c9d7a3 (failed there; fixed: outcomes no longer delete by refusedMakers, the dated read does).
// Adversary R16 on 9c9d7a3. Plan 6.2 / brief: an account refused for a UTC day loses the orders it booked by the end
// of that day; "Orders the account books after the refused day ended are not removed by that refusal."
// The outcome path (`refusedMakers`) carries no day: applyOutcome deletes EVERY order of the maker, so an outcome the
// settler delivers late (outbox retry after an outage across midnight) deletes orders booked on the new day.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { fresh, fund, type Harness } from './harness';
import { DAY_EDGE_SLACK_MS } from '../src/config';
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

describe('adversary R16: a late outcome naming a refused account', () => {
  it("delivered after the UTC day turned, it does not remove the account's order booked on the new day", async () => {
    await place('directMakerSell');
    h.settleAccepts = true;
    await place('directTakerBuy'); // direct pair handed off, accepted, in flight
    const pair = [vec('directMakerSell').hash, vec('directTakerBuy').hash];
    h.held = pair;
    h.refused.add(M); // the settlement fails and the settler refuses M for day D; its outcome is stuck in the outbox
    h.turnDay(nextDay() + DAY_EDGE_SLACK_MS + 1_000); // day D+1, past the day-edge slack: the list is empty again (M's row stays as an earlier day)
    // M books a fresh order on D+1: it is not refused today, and it was booked after the refused day ended
    const r = await place('mintMakerBuy1');
    expect(r.status).toBe(200);
    expect(await ordersOf(M), 'old order in flight + new order').toBe(2);
    // the settler's outbox finally delivers day D's outcome
    const out = { id: 'cccccccccccccccccccccccccccccccc-1', refusedMakers: [M], release: pair };
    expect((await h.call('POST', '/outcome', { body: out })).status).toBe(200);
    h.held = [];
    h.settled.length = 0;
    // the next refusal read (this tick, or any matching pass before it proposes) drops the day-D order only
    await h.tick();
    expect(await h.sql<{ hash: string }>(`SELECT hash FROM orders WHERE maker = ?`, M), 'the D+1 order must stay').toEqual([{ hash: vec('mintMakerBuy1').hash }]);
    expect(JSON.stringify(h.settled)).not.toContain(vec('directMakerSell').hash);
  });
});
