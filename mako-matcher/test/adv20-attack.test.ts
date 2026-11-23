// Adversary R20 on eccf612 (failed there; fixed: an off-chain cancel of a booking in flight takes effect at release, so its
// hash is not free for a new booking while the old match can still report). Req 3 ("orders booked after the exclusion day plus slack are kept") against the settler's
// outcome: it names an order by hash only, so an outcome for an OLD booking acts on a NEWER booking of the same signed
// order (cancelled while in flight, then booked again after the exclusion window).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { utcDay } from '../src/settle';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const ASK = vec('directMakerSell');
let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

const rowAt = async (hash: Hex) => (await h.sql<{ seq: number; created_at: number; in_flight: number }>(`SELECT seq, created_at, in_flight FROM orders WHERE hash = ?`, hash))[0];

describe('adversary R20: an outcome acts on the booking it was proposed for, not on a later booking of the same hash', () => {
  it("the settler's refused drop of booking 1 (inside excluded day D) does not remove booking 2 (after D plus slack)", async () => {
    const end = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
    h.w.nowMs = end - 30_000;
    const D = utcDay(h.w.nowMs);
    fund(h.w, ASK.order, 500_000_000n);
    expect((await h.place(ASK)).status).toBe(200);
    const first = await rowAt(ASK.hash);
    // booking 1 goes in flight (a proposal the settler accepted), then is cancelled off chain and the client books it again
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    const cancel = await h.call('DELETE', `/orders/${ASK.hash}`);
    expect(await cancel.json(), 'in a match: removed when it reports').toEqual({ ok: true, removed: false, atRelease: true });
    h.w.nowMs = end + 2 * 60_000; // past DAY_EDGE_SLACK_MS
    expect((await h.place(ASK)).json, 'booking 1 still holds the hash').toMatchObject({ ok: false, code: 'duplicate_order' });
    // the settler excluded the account for D and reports the drop of the order it held (booking 1)
    h.refusedEarlier.push({ maker: ASK.order.maker.toLowerCase(), day: D });
    const outcome = { id: `${'cd'.repeat(16)}-1`, dropped: [{ hash: ASK.hash, reason: 'refused' }], release: [ASK.hash] };
    expect((await h.call('POST', '/outcome', { body: outcome })).status).toBe(200);
    expect(await rowAt(ASK.hash), 'booking 1 is gone').toBeUndefined();
    // now booking 2, after the exclusion window: kept, also when the same outcome is delivered again
    expect((await h.place(ASK)).status).toBe(200);
    const second = await rowAt(ASK.hash);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect((await h.call('POST', '/outcome', { body: outcome })).status).toBe(200);
    expect(await rowAt(ASK.hash), 'booking 2 was booked after the exclusion window and must stay').toBeDefined();
  });

  it('a booking cancelled off chain while in flight goes at release (an explicit refusal of the hand-off), not before, and is never matched again', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    await h.call('DELETE', `/orders/${ASK.hash}`);
    expect(await rowAt(ASK.hash), 'kept while in flight').toBeDefined();
    h.w.nowMs += 10 * 60_000; // the stale-mark release (the settler holds nothing)
    await h.tick();
    expect(await rowAt(ASK.hash), 'released, then removed').toBeUndefined();
    expect(h.settled).toHaveLength(0);
  });

  it('a resting booking cancelled off chain is removed at once', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    expect(await (await h.call('DELETE', `/orders/${ASK.hash}`)).json()).toEqual({ ok: true, removed: true, atRelease: false });
    expect(await rowAt(ASK.hash)).toBeUndefined();
  });
});
