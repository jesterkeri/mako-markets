// Adversary R17 on ae0a081 (failed there; fixed: DAY_EDGE_SLACK_MS, a refusal for day D drops orders booked up to a minute past its end).
// Adversary R17 on ae0a081. Plan 6.2 / brief requirement 1: an account refused for a UTC day has its booked orders dropped,
// "across ... small clock differences". adv15's clock-skew test books the order BEFORE the market's midnight; here the
// order is booked inside the skew window: after the market's midnight, before the settler's. The refusal row carries the
// settler's day D, the order's created_at carries the market's day D+1, and dropRefused scopes by created_at < end of D.
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

describe('adversary R17: an order booked inside the clock-skew window of the day turn', () => {
  it("settler 2 s behind the market: M's order booked at 00:00:00.5 market time (23:59:58.5 settler time), M then refused for the settler's day, is dropped and never proposed once the settler's clock turns", async () => {
    const skew = 2_000;
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rows: { maker: Hex; day: string }[] = [];
    h.deps.refusalsSince = async (since) => {
      const today = day(h.w.nowMs - skew); // the settler's own clock
      return rows.filter((r) => r.day >= since && r.day <= today).map((r) => ({ maker: r.maker, day: r.day }));
    };
    h.w.nowMs = nextDay() + 500; // market clock: just past midnight; settler clock: still the old day
    expect((await place('directMakerSell')).status).toBe(200); // booked while the settler is still on day D
    rows.push({ maker: M, day: day(h.w.nowMs - skew) }); // the settler refuses M, stamped D (its own day)
    h.w.nowMs += 5_000; // the settler's clock has turned too: D is over for both
    await h.tick();
    await place('directTakerBuy'); // a crossing taker: intake's matching pass
    await h.tick();
    expect(namesM(), 'refused for the day it was booked on (settler time): must never be handed off').toHaveLength(0);
    expect(await ordersOf(M), 'dropped').toBe(0);
  });
});
