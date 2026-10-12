// Adversary pass r3 on ResolverState (RESOLVER_PRICE_PLAN r53 §4.9, commit 51fcbb9). Each case quotes the plan line
// it holds the store to and drives the pure core through calls that arrive late, out of order, or not at all.
// Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import { emptyState, FenceError, LEASE_MS, NONCE_HOLD_MS, ResolverStateCore } from '../src/resolver-state';

const T = 1_000_000;
const MIN = 60_000;
const core = () => new ResolverStateCore(emptyState());
const nd = (nonce: number) => ({ kind: 'no-data' as const, marketId: 9, nonce, calldataHash: '0x0d' });
const st = (nonce: number) => ({ kind: 'settlement' as const, marketId: 5, nonce, calldataHash: '0x05' });

describe('adversary r3: the one release after a store timeout (r53)', () => {
  // §4.9 Lease: "the store refuses a take whose token was already released ... whatever order one run's calls arrive
  // in"; r53: "if no raw send started, the entry, if any, is marked `not_sent` unless reconciled, so a re-check whose
  // passing answer landed late holds nothing". Here the late re-check reaches the store AFTER the release.
  it('a timed-out re-check that reaches the store after the not-sent release arms nothing and does not throw', () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T + 1_000, st(4));
    c.release('a', T + 5_000, { outcome: 'not-sent', entryId: id });
    expect(c.recheck('a', T + 6_000, 4, id)).toEqual({ ok: false, reason: 'lease' });
    expect(c.s.journal[0]).toMatchObject({ armedAt: null, result: 'not_sent' });
    c.take('b', 1, T + MIN);
    expect(c.recheck('b', T + MIN + 1_000, 4, c.journalEntry('b', T + MIN, nd(4)))).toEqual({ ok: true });
  });

  // The same, but the next run already holds the lease when the late re-check lands: still refused, by token.
  it('a late re-check landing inside the next run\'s lease is refused by token', () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T + 1_000, st(4));
    c.release('a', T + 5_000, { outcome: 'not-sent', entryId: id });
    c.take('b', 1, T + 6_000);
    expect(c.recheck('a', T + 7_000, 4, id)).toEqual({ ok: false, reason: 'lease' });
    expect(c.s.journal[0].armedAt).toBeNull();
  });

  // r53: a no-data refund sent production's way is "armed from the release ... and the release comes after Monad's
  // insert, so the hold covers it". The run's late re-check landing after that release must not disturb it.
  it("a no-data re-check landing after the 'sent' release leaves the entry armed from the release", () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T + 1_000, nd(4));
    c.release('a', T + 12_000, { outcome: 'sent', entryId: id });
    expect(c.recheck('a', T + 13_000, 4, id)).toEqual({ ok: false, reason: 'lease' });
    expect(c.s.journal[0]).toMatchObject({ armedAt: T + 12_000, result: null });
    // Held for 345 s from the release, then no longer.
    c.take('b', 1, T + MIN);
    expect(c.recheck('b', T + MIN, 4, c.journalEntry('b', T + MIN, st(4)))).toEqual({ ok: false, reason: 'nonce-held' });
    c.release('b', T + MIN + 1);
    c.take('c', 1, T + 12_000 + NONCE_HOLD_MS);
    expect(c.recheck('c', T + 12_000 + NONCE_HOLD_MS, 4, c.journalEntry('c', T + 12_000 + NONCE_HOLD_MS, st(4)))).toEqual({ ok: true });
  });

  // r53: "(or written armed from the refund's nonce and calldata hash if the entry write itself timed out)".
  // The timed-out entry write may land after the release, or may have landed before it with its answer lost.
  it('a timed-out entry write landing after the armed release is fenced out; one armed entry holds', () => {
    const c = core();
    c.take('a', 1, T);
    c.release('a', T + 12_000, { outcome: 'sent', entry: nd(4) });
    expect(() => c.journalEntry('a', T + 13_000, nd(4))).toThrow(FenceError);
    expect(c.s.journal).toHaveLength(1);
    c.take('b', 1, T + MIN);
    expect(c.recheck('b', T + MIN, 4, c.journalEntry('b', T + MIN, st(4)))).toEqual({ ok: false, reason: 'nonce-held' });
  });
  it('an entry write that landed with its answer lost leaves a second, unarmed copy that holds nothing extra', () => {
    const c = core();
    c.take('a', 1, T);
    c.journalEntry('a', T + 1_000, nd(4)); // landed; the run saw a timeout
    c.release('a', T + 12_000, { outcome: 'sent', entry: nd(4) });
    expect(c.s.journal.map((e) => e.armedAt)).toEqual([null, T + 12_000]);
    // Once the armed copy's hold ends, the unarmed copy does not extend it.
    c.take('b', 1, T + 12_000 + NONCE_HOLD_MS);
    const id = c.journalEntry('b', T + 12_000 + NONCE_HOLD_MS, st(4));
    expect(c.recheck('b', T + 12_000 + NONCE_HOLD_MS, 4, id)).toEqual({ ok: true });
  });

  // File header: "each method is all-or-nothing". A release whose outcome cannot be applied must change nothing.
  it('a release that throws on its outcome changes nothing (lease kept, token not recorded)', () => {
    const c = core();
    c.take('a', 1, T);
    const before = JSON.stringify(c.s);
    expect(() => c.release('a', T + 1_000, { outcome: 'sent' })).toThrow();
    expect(JSON.stringify(c.s)).toBe(before);
  });

  // r53: the store applies the outcome "whether or not the lease is still the run's". A release that lands after
  // its lease expired and the next run took it applies the outcome but leaves the next run's lease alone.
  it("a late 'sent' release inside the next run's lease arms the refund, and the next run's send is held", () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T + 1_000, nd(4));
    c.take('b', 1, T + LEASE_MS);
    c.release('a', T + LEASE_MS + 500, { outcome: 'sent', entryId: id });
    expect(c.fenced('b', T + LEASE_MS + 600)).toBe(true);
    expect(c.recheck('b', T + LEASE_MS + 700, 4, c.journalEntry('b', T + LEASE_MS + 600, st(4)))).toEqual({ ok: false, reason: 'nonce-held' });
  });
});

describe('adversary r3: out-of-funds (r53 §4.9 Turns (b))', () => {
  // r53: an out-of-funds hold "marks the turn's journal entry `not_sent` in the result transaction"; and the void
  // restores count and position but not `lastTurn`.
  it('out-of-funds after a passing re-check: entry not_sent, count and position restored, lastTurn kept', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    const id = c.journalEntry('a', T + 1_000, st(4));
    expect(c.recheck('a', T + 2_000, 4, id)).toEqual({ ok: true });
    c.resultTurn('a', T + 10_000, { result: 'out-of-funds', entryId: id });
    expect(c.s.journal[0].result).toBe('not_sent');
    expect(c.s.candidates[5]).toMatchObject({ count: 0, position: 1 });
    expect(c.s.lastTurn).toMatchObject({ kind: 'settlement', result: 'out-of-funds' });
    expect(c.chooseKind(true, true)).toBe('no-data');
  });
});
