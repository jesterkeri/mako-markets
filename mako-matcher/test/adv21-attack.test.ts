// Adversary R21 on fb50dba (failed there; fixed: every removal outside an outcome only flags a booking in flight).
// Adversary R21 on fb50dba. Req 1: one booking per hash at a time. fb50dba closed the off-chain cancel path, but a
// booking in flight is still removed by the alarm's expiry and on-chain cancel reads, and intake's duplicate check
// (step 4) runs only at the insert, after its awaits. A second intake of the same signed order that is already past
// its early checks therefore books the hash again when the tick frees it, and the late outcome of the old match
// (which names orders by hash) then acts on the new booking.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { Hex } from 'viem';
import { handleAlarm } from '../src/market';
import { fresh, fund, type Harness } from './harness';
import { vec } from './vectors';

const ASK = vec('directMakerSell');
let h: Harness;
beforeEach(async () => {
  h = await fresh('1');
});

const rows = (hash: Hex) => h.sql<{ seq: number; filled: string; in_flight: number }>(`SELECT seq, filled, in_flight FROM orders WHERE hash = ?`, hash);

/// Intake of the same signed order is past its early checks (it reads the settler's refusal list); the tick runs then.
function tickDuringSecondIntake(before: () => void) {
  const inner = h.deps.refusedToday;
  let ran = false;
  h.deps.refusedToday = async (m) => {
    const r = await inner(m);
    if (!ran) {
      ran = true;
      before();
      await handleAlarm(h.state!, env, h.deps);
    }
    return r;
  };
  return () => ran;
}

describe('adversary R21: a hash freed while its booking is in flight can be booked again before that match reports', () => {
  it('expiry: the tick expires booking 1 (in flight) while a second intake of the same order is awaiting; no second booking of the hash may appear', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    expect((await h.place(ASK)).status).toBe(200);
    const first = (await rows(ASK.hash))[0];
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash); // booking 1 is in a match
    // the settler holds that match (its late outcome comes below); a settler holding nothing would have its marks
    // released as stale, and then no outcome can come (added with the fix)
    h.held = [ASK.hash];
    const ran = tickDuringSecondIntake(() => {
      h.w.nowMs = Number(ASK.order.expiration) * 1000; // the order's expiration is reached while intake 2 awaits
    });
    const r = await h.place(ASK);
    expect(ran()).toBe(true);
    const after = await rows(ASK.hash);
    expect(after.every((x) => x.seq === first.seq), `a new booking of the in-flight hash exists (seq ${after.map((x) => x.seq)}); answer ${JSON.stringify(r.json)}`).toBe(true);
    // the late outcome of match 1 must not act on a booking it was not proposed for
    await h.call('POST', '/outcome', { body: { id: `${'ab'.repeat(16)}-1`, applied: [{ hash: ASK.hash, fill: '10000000' }], release: [ASK.hash] } });
    expect((await rows(ASK.hash)).filter((x) => x.seq !== first.seq && x.filled !== '0')).toEqual([]);
  });

  it('on-chain cancel: the tick reads Cancelled for booking 1 (in flight) while a second intake awaits; no second booking of the hash may appear', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    expect((await h.place(ASK)).status).toBe(200);
    const first = (await rows(ASK.hash))[0];
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    h.held = [ASK.hash];
    const ran = tickDuringSecondIntake(() => {
      // cancelled on chain after intake 2 read the order's state (not cancelled), before it inserts
      h.w.block += 5n;
      h.w.logCancelled(ASK.hash, ASK.order.maker, h.w.block);
      h.w.orders.set(ASK.hash, { filled: 0n, cancelled: true });
    });
    const r = await h.place(ASK);
    expect(ran()).toBe(true);
    const after = await rows(ASK.hash);
    expect(after.every((x) => x.seq === first.seq), `a new booking of the in-flight, chain-cancelled hash exists (seq ${after.map((x) => x.seq)}); answer ${JSON.stringify(r.json)}`).toBe(true);
  });

  it('an expired booking in flight is kept until its match reports, then removed (added with the fix)', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    h.held = [ASK.hash];
    h.w.nowMs = Number(ASK.order.expiration) * 1000;
    await h.tick();
    expect(await rows(ASK.hash), 'in flight: kept').toHaveLength(1);
    await h.call('POST', '/outcome', { body: { id: `${'ab'.repeat(16)}-2`, release: [ASK.hash] } });
    expect(await rows(ASK.hash), 'released: removed').toEqual([]);
  });

  it('an order that expires while its own intake awaits is refused, not booked (added with the fix)', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    const inner = h.deps.refusedToday;
    h.deps.refusedToday = async (m) => {
      h.w.nowMs = Number(ASK.order.expiration) * 1000;
      return inner(m);
    };
    const r = await h.place(ASK);
    expect(r.json).toMatchObject({ ok: false, code: 'expired' });
    expect(await rows(ASK.hash)).toEqual([]);
  });

  it('a nonce bump read while a booking is in flight keeps it until its match reports, then removes it (added with the fix)', async () => {
    fund(h.w, ASK.order, 500_000_000n);
    await h.place(ASK);
    await h.sql(`UPDATE orders SET in_flight = ? WHERE hash = ?`, h.w.nowMs, ASK.hash);
    h.held = [ASK.hash];
    h.w.block += 5n;
    h.w.logNonce(ASK.order.maker, ASK.order.nonce + 1n, h.w.block);
    await h.tick();
    expect(await rows(ASK.hash), 'in flight: kept').toHaveLength(1);
    await h.call('POST', '/outcome', { body: { id: `${'ab'.repeat(16)}-3`, release: [ASK.hash] } });
    expect(await rows(ASK.hash), 'released: removed').toEqual([]);
  });
});
