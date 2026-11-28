// Adversary R22 on cab25c8: a seeded random interleaving of intake, cancels, expiry, chain logs, hand-offs, outcomes
// (hold, fill, drop, closed, stop), stale-mark releases and settler outages, checking the in-flight invariants of the
// book after every step. Requirement 1: one booking per hash at a time; outcomes act on the booking they were for; a
// flagged booking is never proposed again and is removed eventually.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { fresh, fund } from './harness';
import { vec } from './vectors';

const NAMES = ['directMakerSell', 'directTakerBuy', 'direct3TakerBuy', 'direct3Maker1Sell', 'direct3Maker2Sell', 'direct3Maker3Sell'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Row = { seq: number; hash: string; in_flight: number; remove_at_release: number; refused: number; filled: string };

describe('adversary R22: random interleavings keep the in-flight invariants', () => {
  for (let seed = 1; seed <= 30; seed++) {
    it(`seed ${seed}`, async () => {
      const h = await fresh('1');
      const r = rng(seed);
      const vs = NAMES.map((n) => vec(n));
      for (const v of vs) fund(h.w, v.order, 900_000_000n);
      const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
      const rows = () => h.sql<Row>(`SELECT seq, hash, in_flight, remove_at_release, refused, filled FROM orders ORDER BY seq`);
      // the settler's single match: hashes with the booking seq each had when it was proposed
      let outstanding = null as { hashes: Hex[]; seqs: Map<string, number> } | null;
      let nid = 1;
      const log: string[] = [];
      const inner = h.deps.settle;
      h.deps.settle = async (b) => {
        const w = b as { taker: { hash: Hex }; makers: { hash: Hex }[] };
        const hs = [w.taker.hash, ...w.makers.map((m) => m.hash)];
        const st = h.state!.storage.sql;
        const seqs = new Map<string, number>();
        for (const x of hs) {
          const row = st.exec<Row>(`SELECT seq, hash, in_flight, remove_at_release, refused, filled FROM orders WHERE hash = ?`, x).toArray()[0];
          if (!row) throw new Error(`proposal names ${x} which is not booked`);
          if (row.remove_at_release) throw new Error(`proposal names flagged booking ${x}`);
          seqs.set(x, row.seq);
        }
        if (outstanding && h.settleAccepts && !h.settlerDown) {
          for (const x of hs) if (outstanding.hashes.includes(x)) throw new Error(`proposal names ${x}, already in an unreported match`);
        }
        const res = await inner(b);
        if (res.accepted) {
          if (outstanding) throw new Error('second accepted match while one is outstanding (fake settler is single)');
          outstanding = { hashes: hs, seqs };
          h.held = hs;
        }
        return res;
      };
      h.settleAccepts = true;

      for (let step = 0; step < 60; step++) {
        const op = Math.floor(r() * 12);
        const v = pick(vs);
        const before = await rows();
        try {
          if (op <= 2) {
            log.push(`place ${v.name}`);
            await h.place(v);
          } else if (op === 3) {
            log.push(`cancel ${v.name}`);
            await h.call('DELETE', `/orders/${v.hash}`);
          } else if (op === 4) {
            log.push('tick');
            await h.tick();
          } else if (op === 5 && outstanding) {
            const o = outstanding;
            const kind = Math.floor(r() * 5);
            const body: Record<string, unknown> = { id: `${'ab'.repeat(16)}-${nid++}`, release: o.hashes };
            if (kind === 1) body.applied = o.hashes.slice(0, 1).map((x) => ({ hash: x, fill: '10000000' }));
            if (kind === 2) body.dropped = [{ hash: pick(o.hashes), reason: pick(['refused', 'cancelled', 'nonce']) }];
            if (kind === 3) body.closed = true;
            if (kind === 4) body.stopMarket = 'x';
            log.push(`outcome kind ${kind}`);
            outstanding = null;
            h.held = [];
            const pre = await rows();
            await h.call('POST', '/outcome', { body });
            // outcomes act on the booking they were proposed for: a booking with another seq must be untouched
            const post = await rows();
            for (const p of pre) {
              if (o.seqs.get(p.hash) === p.seq) continue;
              const q = post.find((x) => x.seq === p.seq);
              if (!o.hashes.includes(p.hash as Hex)) continue;
              if (!q || q.filled !== p.filled) throw new Error(`outcome acted on booking ${p.seq} of ${p.hash}, which it was not proposed for (proposed seq ${o.seqs.get(p.hash)})`);
            }
          } else if (op === 6 && outstanding) {
            log.push('duplicate/old outcome id');
            await h.call('POST', '/outcome', { body: { id: `${'ab'.repeat(16)}-${1 + Math.floor(r() * nid)}`, release: [], applied: outstanding.hashes.slice(0, 1).map((x) => ({ hash: x, fill: '10000000' })) } });
          } else if (op === 7) {
            log.push('chain cancel');
            h.w.block += 5n;
            h.w.logCancelled(v.hash, v.order.maker, h.w.block);
            if (r() < 0.5) h.w.orders.set(v.hash, { filled: 0n, cancelled: true });
          } else if (op === 8) {
            log.push('nonce bump');
            h.w.block += 5n;
            h.w.logNonce(v.order.maker, v.order.nonce + 1n, h.w.block);
          } else if (op === 9) {
            log.push('settler down/up');
            h.settlerDown = !h.settlerDown;
          } else if (op === 10) {
            log.push('+3 min');
            h.w.nowMs += 3 * 60_000;
            await h.tick();
          } else if (op === 11 && r() < 0.5) {
            log.push('restart');
            await h.call('POST', '/restart');
          }
        } catch (e) {
          throw new Error(`seed ${seed} step ${step} [${log.join(' | ')}]: ${(e as Error).message}`);
        }
        const now = await rows();
        for (const x of now) {
          if (x.remove_at_release && x.in_flight === 0) throw new Error(`seed ${seed} step ${step} [${log.join(' | ')}]: flagged booking not in flight ${JSON.stringify(x)}`);
        }
        // a hash's seq never goes backwards: no re-use of a booking
        const seqOfHash = new Map<string, number>();
        for (const x of now) seqOfHash.set(x.hash, x.seq);
        for (const x of before) {
          const s = seqOfHash.get(x.hash);
          if (s !== undefined && s !== x.seq && x.in_flight > 0 && !(outstanding === null)) {
            throw new Error(`seed ${seed} step ${step} [${log.join(' | ')}]: booking ${x.seq} of ${x.hash} (in flight) was replaced by ${s} before its match reported`);
          }
        }
      }
      h.settleAccepts = false; // the final tick may propose again; the settler refuses, so no new mark outlives it
      // liveness: the settler comes back and holds nothing; every mark goes, every flagged booking goes
      h.settlerDown = false;
      h.held = [];
      outstanding = null;
      h.w.nowMs += 10 * 60_000;
      await h.tick();
      const left = await rows();
      expect(left.filter((x) => x.in_flight > 0 || x.remove_at_release > 0), `[${log.join(' | ')}]`).toEqual([]);
    });
  }
});
