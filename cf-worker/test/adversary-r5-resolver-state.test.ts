// Adversary pass r5 on ResolverState (RESOLVER_PRICE_PLAN r55 §4.9, commit b53db56). Each case quotes the plan line
// it holds the store to and drives the pure core through calls that arrive late, out of order, or across a rollout.
// Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import { emptyState, LEASE_MS, NONCE_HOLD_MS, ResolverStateCore } from '../src/resolver-state';

const T = 1_000_000;
const MIN = 60_000;
const core = () => new ResolverStateCore(emptyState());
const nd = (nonce: number) => ({ kind: 'no-data' as const, marketId: 9, nonce, calldataHash: '0x0d' });
const st = (nonce: number) => ({ kind: 'settlement' as const, marketId: 5, nonce, calldataHash: '0x05' });

describe('adversary r5: a run that becomes older mid-run (a deploy lands while it holds the lease)', () => {
  // Plan r55 §4.9 Lease (line 1238): "expiry only frees the lease of a run that crashed"; (1252-1253) "a fenced
  // release with its own 2 s timeout, so the next tick finds the lease free (r44)"; (1284-1285) "**every** release
  // records its token as released, whether or not it deleted anything". r55 (1257-1258): the release "carries the
  // run's version, so an older version's release writes nothing at all". The core applies the r55 rule to every
  // release, so a run of v1 that took the lease while v1 was newest, and ends after a v2 run's take recorded v2, leaves
  // its lease behind: the next v2 tick finds it live and exits (no refund, no turn) until expiry.
  it('the old run releases normally at its end; the next tick finds the lease free', () => {
    const c = core();
    expect(c.take('a-v1', 1, T)).toBe('granted');
    expect(c.take('b-v2', 2, T + MIN)).toBe('held'); // a is still running; v2 is now the newest seen
    c.release('a-v1', T + MIN + 10_000, undefined); // a finishes and releases (it did not crash)
    expect(c.take('c-v2', 2, T + 2 * MIN)).toBe('granted');
  });

  // Plan r55 §4.9 Lease (1276-1279): "Only a crash in the few seconds between a passing re-check and the raw send, or
  // a re-check whose late answer, or an out-of-funds result transaction that times out, followed by a release that
  // also times out (the store-outage limit), leaves an armed entry that was never sent"; (1283) "**No store write ever
  // follows the release (r24)**"; r42 row 5 (line 326): "a released lease has no current token, so every later write
  // with it is refused". (1238) the store applies one run's calls "whatever order one run's calls arrive in".
  // Sequence: v1 run a holds the lease; a v2 take records v2; a's settlement re-check times out at a (in flight), so
  // a ends the run with its one release, which ANSWERS (not-sent: no raw send started) and lands first; then a's
  // re-check lands. Nothing was ever broadcast, yet the entry is armed and holds the nonce 345 s.
  it("an old run's re-check that lands after its answered release arms nothing", () => {
    const c = core();
    c.take('a-v1', 1, T);
    c.startTurn('a-v1', T, { entrants: [{ marketId: 5, close: 0 }], gone: [] }, null);
    c.startTurn('a-v1', T + 1_000, { entrants: [], gone: [] }, { kind: 'settlement', marketId: 5 });
    const id = c.journalEntry('a-v1', T + 70_000, st(4));
    expect(c.take('b-v2', 2, T + MIN)).toBe('held');
    c.release('a-v1', T + 74_000, { outcome: 'not-sent', entryId: id }); // the re-check timed out at the run
    const late = c.recheck('a-v1', T + 75_000, 4, id); // the same re-check, landing after the release
    expect(late).toEqual({ ok: false, reason: 'lease' });
    // The next v2 run's refund at nonce 4 is not held by an entry nothing was ever sent for.
    c.take('c-v2', 2, T + LEASE_MS + 1);
    const rid = c.journalEntry('c-v2', T + LEASE_MS + 1_000, nd(4));
    expect(c.recheck('c-v2', T + LEASE_MS + 2_000, 4, rid)).toEqual({ ok: true });
  });
});

describe('adversary r5: attacks the core withstood (kept as regression cases)', () => {
  // r55: "a `sent` release arms only an unarmed entry, so an entry armed by its passing re-check keeps that time", and
  // "the run's own `not_sent` mark is cleared"; reconciliation results stay final.
  it('a sent release does not reopen a reconciled entry, and does not move an existing arming time', () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T, nd(4));
    expect(c.recheck('a', T + 1_000, 4, id)).toEqual({ ok: true });
    c.reconcile('a', T + 2_000, id, 'dropped');
    c.release('a', T + 3_000, { outcome: 'sent', entryId: id });
    expect(c.s.journal[0]).toMatchObject({ result: 'dropped', armedAt: T + 1_000 });
  });

  // r55 row 1: an error-answered send is `not_sent`, so the next send at that nonce is not held.
  it('an error-answered refund on the store-unavailable path writes no entry and holds nothing', () => {
    const c = core();
    c.release('su', T + 9_000, { outcome: 'not-sent' });
    expect(c.s.journal).toEqual([]);
    c.take('b', 1, T + MIN);
    const id = c.journalEntry('b', T + MIN, st(4));
    expect(c.recheck('b', T + MIN + 1_000, 4, id)).toEqual({ ok: true });
  });

  // An older version's late `sent` release cannot arm, and its take cannot be granted, in either order.
  // Plan r56 reverses r55 here: a release is applied whatever the run's version (r43 covers decision state only), so
  // an older run's store-unavailable refund is held by its release; its take, landing after, is still refused.
  it('an older run whose take and release both land after a newer take: the release holds its refund, the take is refused (r56)', () => {
    const c = core();
    c.take('n', 2, T);
    c.release('n', T + 1_000);
    expect(c.release('o', T + 2_000, { outcome: 'sent', entry: nd(4) })).toBe(false); // it held no lease
    expect(c.s.journal).toHaveLength(1);
    expect(c.s.journal[0]).toMatchObject({ writer: 'o', armedAt: T + 2_000 });
    expect(c.take('o', 1, T + 3_000)).toBe('older');
    expect(c.s.lease).toBeNull();
  });

  // The hold still ends at 345 s for an entry armed by a sent release on the store-unavailable path.
  it('a store-unavailable entry written armed holds exactly NONCE_HOLD_MS', () => {
    const c = core();
    c.release('su', T, { outcome: 'sent', entry: nd(4) });
    c.take('b', 1, T + NONCE_HOLD_MS - 1);
    const id = c.journalEntry('b', T + NONCE_HOLD_MS - 1, st(4));
    expect(c.recheck('b', T + NONCE_HOLD_MS - 1, 4, id)).toEqual({ ok: false, reason: 'nonce-held' });
    c.release('b', T + NONCE_HOLD_MS, undefined);
    c.take('c', 1, T + NONCE_HOLD_MS);
    const id2 = c.journalEntry('c', T + NONCE_HOLD_MS, st(4));
    expect(c.recheck('c', T + NONCE_HOLD_MS, 4, id2)).toEqual({ ok: true });
  });
});
