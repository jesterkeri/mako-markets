// Codex MATCHER R8. F1: a hash identifies signed content, not one booking. An order removed and booked again while a
// pass awaits is a newer order with another time and priority, so the pass's snapshot check compares `seq` too and
// hands over nothing stale. F2/F3: every removal as refused, by any path and at any point after intake's insert, is
// recorded by booking (`refused_drops`), and intake answers from that record: a removal before the pass starts, and a
// flagged in-flight order released (explicit refusal, release-only outcome, the settler's refused drop) before the answer.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { dropRefused, insertOrder } from '../src/book';
import { handleAlarm } from '../src/market';
import { applyOutcome } from '../src/outcome';
import { utcDay } from '../src/settle';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const ASK = vec('directMakerSell');
const BID = vec('directTakerBuy');

let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

async function place(name: string) {
  const v = vec(name);
  fund(h.w, v.order, 500_000_000n);
  return h.place(v);
}
const sqlNow = () => h.state!.storage.sql;
const rowOf = (hash: Hex) => sqlNow().exec<{ seq: number; created_at: number; fee: string; filled: string }>(`SELECT seq, created_at, fee, filled FROM orders WHERE hash = ?`, hash).toArray()[0];
/// The same, from the test body (outside the object's context).
const rowAt = async (hash: Hex) => (await h.sql<{ seq: number; created_at: number }>(`SELECT seq, created_at FROM orders WHERE hash = ?`, hash))[0];
type Wire = { taker: { hash: Hex; bookedAt: number }; makers: { hash: Hex; bookedAt: number }[] };

/// Removes `v`'s booking and books the same signed order again (as a cancel then a client's rebooking would), newer.
function rebook(v: typeof ASK) {
  const r = rowOf(v.hash);
  sqlNow().exec(`DELETE FROM orders WHERE hash = ?`, v.hash);
  insertOrder(sqlNow(), v.order, v.hash, v.signature, BigInt(r.fee), BigInt(r.filled), h.w.nowMs + 1_000);
}

/// Runs `during` once, at the first chain read after the order `hash` is stored (inside its intake's matching pass).
function atFirstReadAfterStored(hash: Hex, during: () => Promise<void> | void) {
  const inner = h.deps.fetch;
  let done = false;
  h.deps.fetch = async (i, x) => {
    if (!done && h.state && rowOf(hash)) {
      done = true;
      await during();
    }
    return inner(i, x);
  };
  return () => (h.deps.fetch = inner);
}

describe('Codex R8 F1: a booking replaced while a pass awaits is not handed over from the old snapshot', () => {
  it('the resting maker is cancelled and rebooked: no stale hand-off; the next one has the rebooked order as the newer taker, with its own booking time', async () => {
    await place('directMakerSell');
    const restore = atFirstReadAfterStored(BID.hash, () => rebook(ASK));
    const r = await place('directTakerBuy');
    restore();
    expect(r.json, 'nothing handed over from the stale snapshot').toMatchObject({ handedOff: 0 });
    expect(h.settled).toHaveLength(0);
    await h.tick();
    expect(h.settled).toHaveLength(1);
    const p = h.settled[0] as Wire;
    expect(p.taker.hash, 'the rebooked ask is now the newer order: it takes').toBe(ASK.hash);
    expect(p.makers.map((m) => m.hash)).toEqual([BID.hash]);
    expect(p.taker.bookedAt, "the replacement's booking time").toBe((await rowAt(ASK.hash)).created_at);
  });

  it('the taker itself is cancelled and rebooked: no stale hand-off; the next one carries the new booking time', async () => {
    await place('directMakerSell');
    const restore = atFirstReadAfterStored(BID.hash, () => rebook(BID));
    const r = await place('directTakerBuy');
    restore();
    expect(r.json).toMatchObject({ handedOff: 0 });
    expect(h.settled).toHaveLength(0);
    await h.tick();
    const p = h.settled[0] as Wire;
    expect(p.taker.hash).toBe(BID.hash);
    expect(p.taker.bookedAt).toBe((await rowAt(BID.hash)).created_at);
  });

  it('across an exclusion boundary: the first booking is inside the excluded day, the rebooking after its slack; the old booking time never reaches the settler', async () => {
    const end = (Math.floor(h.w.nowMs / 86_400_000) + 1) * 86_400_000;
    h.w.nowMs = end - 30_000;
    const D = utcDay(h.w.nowMs);
    await place('directMakerSell');
    const oldAt = (await rowAt(ASK.hash)).created_at;
    h.w.nowMs = end + 2 * 60_000; // past the slack
    const restore = atFirstReadAfterStored(BID.hash, () => {
      rebook(ASK);
      h.refusedEarlier.push({ maker: ASK.order.maker.toLowerCase() as Hex, day: D }); // the ask's account excluded for D
    });
    await place('directTakerBuy');
    restore();
    await h.tick();
    const all = h.settled as Wire[];
    for (const p of all) for (const x of [p.taker, ...p.makers]) expect(x.bookedAt, 'the D booking time is never sent').not.toBe(oldAt);
    expect(all.some((p) => [p.taker, ...p.makers].some((x) => x.hash === ASK.hash)), 'the rebooked order is still eligible').toBe(true);
  });
});

describe('Codex R8 F2: a removal as refused right after the insert, before the pass', () => {
  it('a concurrent refusal read drops the new order before intake reaches its pass: 400 account_refused', async () => {
    const inner = h.deps.now;
    let done = false;
    // the first booking of the market: intake sets the alarm after the insert, reading the clock; a refusal read
    // completing at that moment drops the order
    h.deps.now = () => {
      const t = inner();
      if (!done && h.state && rowOf(ASK.hash)) {
        done = true;
        dropRefused(sqlNow(), [{ maker: ASK.order.maker.toLowerCase() as Hex, day: utcDay(t) }], t);
      }
      return t;
    };
    const r = await place('directMakerSell');
    h.deps.now = inner;
    expect(done, 'the drop ran between the insert and the pass').toBe(true);
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ ok: false, code: 'account_refused' });
  });
});

describe('Codex R8 F3: an order flagged in flight and released before intake answers', () => {
  const alert = () => {};
  /// Intake of BID is held at its pass's first read; a tick then hands off the pair, during which `onHandoff` runs and
  /// its answer is returned.
  async function heldIntake(onHandoff: (hashes: Hex[]) => { accepted: boolean }, afterTick?: () => void) {
    await place('directMakerSell');
    const settle = h.deps.settle;
    let inTick = false;
    const restore = atFirstReadAfterStored(BID.hash, async () => {
      inTick = true;
      h.deps.settle = async (b) => {
        h.settled.push(b);
        const w = b as Wire;
        return onHandoff([w.taker.hash, ...w.makers.map((m) => m.hash)]);
      };
      await handleAlarm(h.state!, env, h.deps);
      h.deps.settle = settle;
      afterTick?.();
    });
    const r = await place('directTakerBuy');
    restore();
    expect(inTick, 'the tick ran while intake was held').toBe(true);
    return r;
  }
  const flagBid = () => dropRefused(sqlNow(), [{ maker: BID.order.maker.toLowerCase() as Hex, day: utcDay(h.w.nowMs) }], h.w.nowMs);

  it('flagged, then the hand-off is explicitly refused: released and removed as refused; 400 account_refused', async () => {
    const r = await heldIntake(() => {
      flagBid();
      return { accepted: false };
    });
    expect(await rowAt(BID.hash)).toBeUndefined();
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: 'account_refused' });
  });

  it('flagged, accepted, then a release-only outcome: removed as refused; 400 account_refused', async () => {
    let hashes: Hex[] = [];
    const r = await heldIntake(
      (hs) => {
        hashes = hs;
        flagBid();
        return { accepted: true };
      },
      () => applyOutcome(sqlNow(), { id: `${'ab'.repeat(16)}-1`, release: hashes }, alert, h.w.nowMs),
    );
    expect(await rowAt(BID.hash)).toBeUndefined();
    expect(r.status).toBe(400);
  });

  it("accepted, then the settler's outcome drops it as refused: 400 account_refused", async () => {
    let hashes: Hex[] = [];
    const r = await heldIntake(
      (hs) => {
        hashes = hs;
        return { accepted: true };
      },
      () => applyOutcome(sqlNow(), { id: `${'ab'.repeat(16)}-2`, dropped: [{ hash: BID.hash, reason: 'refused' }], release: hashes }, alert, h.w.nowMs),
    );
    expect(await rowAt(BID.hash)).toBeUndefined();
    expect(r.status).toBe(400);
  });

  it('a full fill is not a refusal: filled and released before the answer, booked false', async () => {
    let hashes: Hex[] = [];
    const r = await heldIntake(
      (hs) => {
        hashes = hs;
        return { accepted: true };
      },
      () => applyOutcome(sqlNow(), { id: `${'ab'.repeat(16)}-3`, applied: hashes.map((x) => ({ hash: x, fill: BID.order.size.toString() })), release: hashes }, alert, h.w.nowMs),
    );
    expect(await rowAt(BID.hash)).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, booked: false });
  });

  it('control: flagged and still in flight through the answer: stored, booked true', async () => {
    const r = await heldIntake(() => {
      flagBid();
      return { accepted: true };
    });
    expect(await rowAt(BID.hash)).toBeDefined();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, booked: true });
  });
});

describe('refused_drops pruning', () => {
  it('a record outlives a later tick while its intake still waits (minutes later), and is gone once answered or old', async () => {
    await place('directMakerSell');
    const restore = atFirstReadAfterStored(BID.hash, async () => {
      h.refused.add(BID.order.maker.toLowerCase()); // excluded today, after intake's own check
      await handleAlarm(h.state!, env, h.deps); // drops the order and records it
      h.w.nowMs += 5 * 60_000;
      await handleAlarm(h.state!, env, h.deps); // a later tick prunes old records; this one is still wanted
    });
    const r = await place('directTakerBuy');
    restore();
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: 'account_refused' });
    expect(await h.sql(`SELECT seq FROM refused_drops`), 'read and cleared by its intake').toEqual([]);
  });

  it('a record no intake reads is pruned by the tick after REFUSED_DROP_KEEP_MS', async () => {
    await place('directMakerSell');
    await place('directTakerBuy'); // another account: keeps the book non-empty
    h.refused.add(ASK.order.maker.toLowerCase());
    await h.tick();
    expect(await h.sql(`SELECT seq FROM refused_drops`)).toHaveLength(1);
    h.w.nowMs += 11 * 60_000;
    await h.tick();
    expect(await h.sql(`SELECT seq FROM refused_drops`)).toEqual([]);
  });

  it('the tick prunes an old record on an emptied book too (adversary R20 note)', async () => {
    await place('directMakerSell');
    h.refused.add(ASK.order.maker.toLowerCase());
    await h.tick(); // drops the only order: the book is empty
    expect(await h.sql(`SELECT seq FROM refused_drops`)).toHaveLength(1);
    h.w.nowMs += 11 * 60_000;
    await h.tick();
    expect(await h.sql(`SELECT seq FROM refused_drops`)).toEqual([]);
  });
});
