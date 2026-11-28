// Adversary R22 on cab25c8 (both failed there; fixed: a booking flagged remove_at_release answers booked:false and leaves the feed).
// Adversary R22 on cab25c8. Probes of the "only an outcome or a release removes a booking in flight" rule and of what a
// booking flagged remove_at_release does to the intake answer, the book feed, capacity and reservations.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { cancelOrder } from '../src/book';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const ASK = vec('directMakerSell');
const BID = vec('directTakerBuy');
let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

const rows = (hash: Hex) => h.sql<{ seq: number; in_flight: number; remove_at_release: number }>(`SELECT seq, in_flight, remove_at_release FROM orders WHERE hash = ?`, hash);

describe('adversary R22: the intake answer and the feed for a booking that was cancelled while in flight', () => {
  it('GET /book does not show a booking flagged refused while in flight (added with the fix)', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    const levels = async () => ((await (await h.call('GET', '/book')).json()) as { levels: unknown[] }).levels;
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    expect(await levels(), 'in flight, not flagged: still listed').toHaveLength(1);
    await h.sql(`UPDATE orders SET refused = 1 WHERE hash = ?`, ASK.hash);
    expect(await levels()).toEqual([]);
  });

  it('intake answers booked:false for its own booking when a cancel arrives while the hand-off is awaited (eccf612: "a cancel, fill or expiry gives false")', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    expect((await h.place(ASK)).status).toBe(200);
    fund(h.w, BID.order, 500_000_000n);
    const inner = h.deps.settle;
    h.deps.settle = async (b) => {
      // the maker cancels off chain while the hand-off of the match is in the settler's hands
      expect(cancelOrder(h.state!.storage.sql, BID.hash)).toBe('at_release');
      return inner(b);
    };
    h.settleAccepts = true;
    const r = await h.place(BID);
    expect(r.json).toMatchObject({ ok: true, handedOff: 1, handoff: 'accepted' });
    expect(r.json.booked, `the cancelled booking is flagged ${JSON.stringify(await rows(BID.hash))} and the answer says booked: ${r.json.booked}`).toBe(false);
  });

  it('GET /book does not show a booking the maker cancelled while it was in flight', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    h.held = [ASK.hash];
    const before = (await (await h.call('GET', '/book')).json()) as { levels: unknown[] };
    expect(before.levels).toHaveLength(1);
    await h.call('DELETE', `/orders/${ASK.hash}`);
    const after = (await (await h.call('GET', '/book')).json()) as { levels: unknown[] };
    expect(after.levels, 'a cancelled order that can never be proposed again is still listed').toEqual([]);
  });
});
