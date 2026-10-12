// Adversary pass r4 on ResolverState (RESOLVER_PRICE_PLAN r54 §4.9, commit d413aaa). Each case quotes the plan line
// it holds the store to and drives the pure core through calls that arrive late, out of order, or not at all.
// Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import { emptyState, LEASE_MS, NONCE_HOLD_MS, ResolverStateCore } from '../src/resolver-state';

const T = 1_000_000;
const MIN = 60_000;
const core = () => new ResolverStateCore(emptyState());
const nd = (nonce: number) => ({ kind: 'no-data' as const, marketId: 9, nonce, calldataHash: '0x0d' });
const st = (nonce: number) => ({ kind: 'settlement' as const, marketId: 5, nonce, calldataHash: '0x05' });

describe('adversary r4: the release carries the send (r54)', () => {
  // Plan r54 §4.9 Lease (lines 1247-1250): "a later one ends the run ..., except that a timeout **in a no-data turn**
  // finishes that refund production's way ... so refunds never wait on the store"; "A re-check refused for **any**
  // reason (r52) writes `not_sent` on the journal entry in the result transaction". Lines 1233-1240: the release
  // "comes after the run's raw send ... if a raw send was made, of either kind, the entry is **armed** from the
  // release". Only the not-sent branch says "unless reconciled"; `not_sent` is the result transaction's mark, not a
  // reconciliation result (§4.9 Journal: confirmed, replaced, dropped, reverted, nonce_consumed).
  // Sequence: a no-data turn's re-check is refused (too little lease left); its result transaction, marking the
  // entry not_sent, times out at the run but lands; the run finishes the refund production's way (a real send at
  // nonce 4); its one release says `sent` for that entry. The refund is in Monad's pool, so the next settlement turn
  // at nonce 4 must be held; the core leaves the entry not_sent and lets it through (a counted turn, R7).
  it("a refund finished production's way after its own result transaction landed is armed by the release", () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 9 });
    const id = c.journalEntry('a', T + 150_000, nd(4));
    expect(c.recheck('a', T + 165_000, 4, id)).toEqual({ ok: false, reason: 'time-left' });
    c.resultTurn('a', T + 165_500, { result: 'failed', entryId: id, notSent: true }); // landed; the run saw a timeout
    // ... the refund goes out production's way at nonce 4, then the one release:
    c.release('a', T + 170_000, { outcome: 'sent', entryId: id });
    c.take('b', 1, T + 3 * MIN);
    const sid = c.journalEntry('b', T + 3 * MIN + 1_000, st(4));
    expect(c.recheck('b', T + 3 * MIN + 2_000, 4, sid)).toEqual({ ok: false, reason: 'nonce-held' });
  });
});

describe('adversary r4: attacks the core withstood (kept as regression cases)', () => {
  // r54 row 3: "a release's outcome applies only to an entry its own token wrote". A run's late `sent` release cannot
  // re-arm, and its late `not-sent` cannot disarm, another run's entry at the same nonce.
  it("a late release from an earlier run changes nothing on a later run's entry", () => {
    const c = core();
    c.take('a', 1, T);
    c.release('a', T + 5_000);
    c.take('b', 1, T + MIN);
    const id = c.journalEntry('b', T + MIN, nd(4));
    expect(c.recheck('b', T + MIN + 1_000, 4, id)).toEqual({ ok: true });
    c.release('a', T + MIN + 2_000, { outcome: 'not-sent', entryId: id });
    c.release('a', T + MIN + 3_000, { outcome: 'sent', entryId: id });
    expect(c.s.journal[0]).toMatchObject({ armedAt: T + MIN + 1_000, result: null });
    expect(c.fenced('b', T + MIN + 4_000)).toBe(true);
  });

  // r54: "(or written armed, with this token as writer, ... as on the store-unavailable path)"; r45-r46: a take that
  // lands after its run's release is refused. The take of a store-unavailable run arrives after its release.
  it('a store-unavailable run whose take lands after its release: entry armed, take refused, lease free', () => {
    const c = core();
    c.release('su', T + 9_000, { outcome: 'sent', entry: nd(4) });
    expect(c.take('su', 1, T + 10_000)).toBe('token-released');
    expect(c.s.lease).toBeNull();
    expect(c.take('b', 1, T + MIN)).toBe('granted');
    expect(c.recheck('b', T + MIN, 4, c.journalEntry('b', T + MIN, st(4)))).toEqual({ ok: false, reason: 'nonce-held' });
  });

  // r54 row 1: an out-of-funds settlement whose result transaction timed out AND landed: the release is idempotent.
  it('an out-of-funds result transaction that landed late, then the not-sent release: one not_sent entry, nothing held', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    const id = c.journalEntry('a', T + 1_000, st(4));
    expect(c.recheck('a', T + 2_000, 4, id)).toEqual({ ok: true });
    c.resultTurn('a', T + 12_000, { result: 'out-of-funds', entryId: id });
    c.release('a', T + 14_000, { outcome: 'not-sent', entryId: id });
    expect(c.s.journal[0].result).toBe('not_sent');
    c.take('b', 1, T + MIN);
    expect(c.recheck('b', T + MIN, 4, c.journalEntry('b', T + MIN, nd(4)))).toEqual({ ok: true });
  });

  // As the plan is written (r54 lines 1238-1240, "a raw send was made, of either kind ... armed"), a refund that the
  // node refused at an occupied nonce is armed too, even though the store's own re-check had just refused that nonce
  // as held. The core matches the text; the consequence (a 345 s hold for a send that never entered the pool) is the
  // plan defect D1 in archive/adversary-plan-tests-2026-10-10/r54.
  it('a no-data refund whose timed-out re-check the store refused as held is armed by its sent release (as written)', () => {
    const c = core();
    c.take('s', 1, T);
    const sid = c.journalEntry('s', T, st(4));
    expect(c.recheck('s', T + 1_000, 4, sid)).toEqual({ ok: true }); // a settlement, later dropped by Monad
    c.release('s', T + 10_000);
    c.take('a', 1, T + 290_000);
    const id = c.journalEntry('a', T + 290_000, nd(4));
    expect(c.recheck('a', T + 291_000, 4, id)).toEqual({ ok: false, reason: 'nonce-held' }); // answer lost
    c.release('a', T + 294_000, { outcome: 'sent', entryId: id }); // Monad refused it: the settlement still pending
    c.take('b', 1, T + 1_000 + NONCE_HOLD_MS + 1_000);
    const id2 = c.journalEntry('b', T + 1_000 + NONCE_HOLD_MS + 1_000, nd(4));
    expect(c.recheck('b', T + 1_000 + NONCE_HOLD_MS + 1_000, 4, id2)).toEqual({ ok: false, reason: 'nonce-held' });
  });

  // §4.9 Lease: "every release records its token as released, whether or not it deleted anything" (r46), for a
  // token whose lease already expired and was taken by another run.
  it('a release after its lease expired and was retaken records its token and leaves the new lease', () => {
    const c = core();
    c.take('a', 1, T);
    c.take('b', 1, T + LEASE_MS + 1);
    expect(c.release('a', T + LEASE_MS + 2, { outcome: 'not-sent' })).toBe(false);
    expect(c.take('a', 1, T + LEASE_MS + 3)).toBe('token-released');
    expect(c.fenced('b', T + LEASE_MS + 4)).toBe(true);
  });
});
