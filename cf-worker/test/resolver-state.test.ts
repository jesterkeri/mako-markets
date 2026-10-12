// ResolverState's rules (RESOLVER_PRICE_PLAN r55 §4.9), spec-first: each case is written from the plan's text and run
// against the pure core in src/resolver-state.ts. Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  emptyState,
  FenceError,
  LEASE_MS,
  NONCE_HOLD_MS,
  RELEASED_TOKEN_TTL_MS,
  ResolverStateCore,
} from '../src/resolver-state';

const core = () => new ResolverStateCore(emptyState());
const T = 1_000_000;

describe('lease (§4.9 Lease and timing)', () => {
  it('one holder at a time; a live lease is not taken over; it expires after 180 s', () => {
    const c = core();
    expect(c.take('a', 1, T)).toBe('granted');
    expect(c.take('b', 1, T + 1)).toBe('held');
    expect(c.take('b', 1, T + LEASE_MS)).toBe('granted');
  });
  it('exact fencing: only the current, unexpired token passes; release frees it', () => {
    const c = core();
    c.take('a', 1, T);
    expect(c.fenced('a', T + 1)).toBe(true);
    expect(c.fenced('b', T + 1)).toBe(false);
    expect(c.fenced('a', T + LEASE_MS)).toBe(false);
    expect(c.release('a', T + 2)).toBe(true);
    expect(c.fenced('a', T + 3)).toBe(false);
    expect(c.take('b', 1, T + 3)).toBe('granted');
  });
  it('every release records its token, so a late take for it is refused, whatever the order (r45, r46)', () => {
    const c = core();
    expect(c.release('late', T)).toBe(false); // deleted nothing, still recorded
    expect(c.take('late', 1, T + 200_000)).toBe('token-released');
    expect(c.take('late', 1, T + RELEASED_TOKEN_TTL_MS + 1)).toBe('granted'); // after 24 h it is forgotten
  });
  it('a token is released only if it was recorded, never by an inherited name', () => {
    expect(core().take('constructor', 1, T)).toBe('granted');
  });
  it('an older take does not even prune old released tokens (it writes nothing)', () => {
    const c = core();
    c.take('new', 5, T);
    c.release('new', T + 1);
    c.take('old', 4, T + RELEASED_TOKEN_TTL_MS + 10);
    expect(Object.keys(c.s.released)).toEqual(['t:new']);
  });
  it('an older version gets no lease and writes nothing (r44)', () => {
    const c = core();
    c.take('new', 5, T);
    c.release('new', T + 1);
    const before = JSON.stringify(c.s);
    expect(c.take('old', 4, T + 2)).toBe('older');
    expect(JSON.stringify(c.s)).toBe(before);
    expect(c.take('same', 5, T + 3)).toBe('granted'); // equal is not older
  });
  it('a write without the current lease is refused', () => {
    const c = core();
    c.take('a', 1, T);
    expect(() => c.demoteBatch('b', T + 1)).toThrow(FenceError);
    expect(() => c.journalEntry('a', T + LEASE_MS, { kind: 'no-data', marketId: 1, nonce: 0, calldataHash: '0x' })).toThrow(FenceError);
  });
});

describe('the re-check before the raw send (r41, r49, r51, r52)', () => {
  const entry = (c: ResolverStateCore, token: string, now: number, nonce: number) =>
    c.journalEntry(token, now, { kind: 'settlement', marketId: 7, nonce, calldataHash: '0xab' });

  it('needs 20 s of lease left', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 0);
    expect(c.recheck('a', T + LEASE_MS - 19_999, 0, id)).toEqual({ ok: false, reason: 'time-left' });
    expect(c.recheck('a', T + LEASE_MS - 20_000, 0, id)).toEqual({ ok: true });
  });
  it("a turn's own entry, written just before its re-check, does not hold it; the pass arms it (r52)", () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T + 30_000, 7);
    expect(c.s.journal[0].armedAt).toBeNull();
    expect(c.recheck('a', T + 34_000, 7, id)).toEqual({ ok: true });
    expect(c.s.journal[0].armedAt).toBe(T + 34_000);
  });
  it('an armed entry holds its nonce 345 s from its passing re-check, hash or not; then it is presumed dropped', () => {
    const c = core();
    c.take('a', 1, T);
    const sent = entry(c, 'a', T, 4);
    c.recheck('a', T + 1000, 4, sent); // armed at T + 1000; its response is lost, so no hash
    const next = entry(c, 'a', T + 2000, 4);
    expect(c.recheck('a', T + 2000, 4, next)).toEqual({ ok: false, reason: 'nonce-held' });
    expect(c.s.journal.find((e) => e.id === next)!.armedAt).toBeNull(); // refused: never armed
    c.release('a', T + 3000);
    c.take('b', 1, T + 1000 + NONCE_HOLD_MS - 1);
    expect(c.recheck('b', T + 1000 + NONCE_HOLD_MS - 1, 4, entry(c, 'b', T + 1000 + NONCE_HOLD_MS - 1, 4))).toEqual({
      ok: false,
      reason: 'nonce-held',
    });
    c.release('b', T + 1000 + NONCE_HOLD_MS);
    c.take('c', 1, T + 1000 + NONCE_HOLD_MS);
    expect(c.recheck('c', T + 1000 + NONCE_HOLD_MS, 4, entry(c, 'c', T + 1000 + NONCE_HOLD_MS, 4))).toEqual({ ok: true });
    expect(c.s.journal.find((e) => e.id === sent)!.presumedDropped).toBe(true);
    expect(c.s.journal.find((e) => e.id === sent)!.result).toBeNull(); // not final
  });
  it('an armed entry holds its own nonce and lower ones, never a higher nonce', () => {
    const c = core();
    c.take('a', 1, T);
    c.recheck('a', T + 1, 4, entry(c, 'a', T, 4));
    expect(c.recheck('a', T + 2, 5, entry(c, 'a', T + 2, 5))).toEqual({ ok: true });
    expect(c.recheck('a', T + 3, 3, entry(c, 'a', T + 3, 3))).toEqual({ ok: false, reason: 'nonce-held' });
  });
  it('an entry that never reached its re-check (a crash) or was refused holds nothing (r52)', () => {
    const c = core();
    c.take('a', 1, T);
    const crashed = entry(c, 'a', T, 4); // the run crashed here, before its re-check
    const refused = entry(c, 'a', T + 1, 4);
    c.recheck('a', LEASE_MS + T - 10_000, 4, refused); // refused for time left
    c.release('a', T + 2);
    c.take('b', 1, T + 60_000);
    expect(c.recheck('b', T + 60_000, 4, entry(c, 'b', T + 60_000, 4))).toEqual({ ok: true });
    for (const id of [crashed, refused]) {
      expect(c.s.journal.find((e) => e.id === id)).toMatchObject({ armedAt: null, presumedDropped: false }); // never held
    }
  });
  it('a dropped response-lost send holds at most 345 s, then every later turn sends (no endless re-arming, r52)', () => {
    const c = core();
    let now = T;
    let run = 0;
    const tick = () => {
      const tok = `run-${run++}`;
      expect(c.take(tok, 1, now)).toBe('granted');
      const id = entry(c, tok, now, 4); // the finalized nonce stays 4: the lost send was dropped, nothing landed
      const r = c.recheck(tok, now + 1000, 4, id);
      if (!r.ok) c.resultTurn(tok, now + 2000, { result: 'failed', entryId: id, notSent: true });
      c.release(tok, now + 3000);
      now += 60_000;
      return r.ok;
    };
    expect(tick()).toBe(true); // the lost send: armed, then its response is lost
    const after = Array.from({ length: 10 }, tick);
    // Held while the lost send can still be in the pool (armed at T + 1000, ticks re-check at T + k*60 s + 1000).
    expect(after.slice(0, 5).every((ok) => !ok)).toBe(true);
    expect(after[5]).toBe(true); // 360 s after arming: past the 345 s hold
  });
  it('a reconciled entry holds nothing', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.recheck('a', T + 1, 4, id);
    c.reconcile('a', T + 10, id, 'confirmed');
    expect(c.recheck('a', T + 20, 4, entry(c, 'a', T + 20, 4))).toEqual({ ok: true });
  });
  it('the asking entry must be open and unarmed', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.recheck('a', T + 1, 4, id);
    expect(() => c.recheck('a', T + 2, 4, id)).toThrow();
    expect(() => c.recheck('a', T + 2, 4, 999)).toThrow();
  });
});

describe('the one release after a store timeout (r53)', () => {
  const entry = (c: ResolverStateCore, token: string, now: number, nonce: number, kind: 'settlement' | 'no-data' = 'settlement') =>
    c.journalEntry(token, now, { kind, marketId: 7, nonce, calldataHash: '0xab' });

  it('a re-check that passed in the store but timed out for the run: the release marks the entry not_sent', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    expect(c.recheck('a', T + 1000, 4, id)).toEqual({ ok: true }); // landed, but the run saw a timeout and sent nothing
    c.release('a', T + 3000, { outcome: 'not-sent', entryId: id });
    expect(c.s.journal[0]).toMatchObject({ result: 'not_sent' });
    c.take('b', 1, T + 60_000);
    expect(c.recheck('b', T + 60_000, 4, entry(c, 'b', T + 60_000, 4, 'no-data'))).toEqual({ ok: true }); // the refund sends
  });
  it("a refund sent production's way after a re-check timeout: the release arms its entry, so the next turn is held", () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4, 'no-data'); // its re-check timed out before reaching the store; the refund was sent
    c.release('a', T + 12_000, { outcome: 'sent', entryId: id });
    expect(c.s.journal[0].armedAt).toBe(T + 12_000);
    c.take('b', 1, T + 60_000);
    expect(c.recheck('b', T + 60_000, 4, entry(c, 'b', T + 60_000, 4))).toEqual({ ok: false, reason: 'nonce-held' });
  });
  it('a refund sent after its entry write timed out: the release writes the entry armed', () => {
    const c = core();
    c.take('a', 1, T);
    c.release('a', T + 12_000, { outcome: 'sent', entry: { kind: 'no-data', marketId: 9, nonce: 4, calldataHash: '0xcd' } });
    expect(c.s.journal[0]).toMatchObject({ marketId: 9, nonce: 4, armedAt: T + 12_000, result: null });
    expect(() => c.release('a', T + 13_000, { outcome: 'sent' })).toThrow(); // nothing to write it from
  });
  it("the release's outcome applies even when the lease has expired, and never touches a reconciled entry", () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.take('b', 1, T + LEASE_MS); // a's lease expired and b holds it
    c.release('a', T + LEASE_MS + 1, { outcome: 'not-sent', entryId: id });
    expect(c.s.journal[0].result).toBe('not_sent');
    expect(c.fenced('b', T + LEASE_MS + 2)).toBe(true); // b's lease is untouched
    const id2 = entry(c, 'b', T + LEASE_MS + 3, 5);
    c.reconcile('b', T + LEASE_MS + 4, id2, 'confirmed');
    c.release('b', T + LEASE_MS + 5, { outcome: 'not-sent', entryId: id2 });
    expect(c.s.journal[1].result).toBe('confirmed');
  });
  it('an out-of-funds settlement whose result transaction timed out: its release marks the entry not_sent (r54)', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.recheck('a', T + 1000, 4, id); // armed; the node then answers insufficient funds; the result write times out
    c.release('a', T + 12_000, { outcome: 'not-sent', entryId: id });
    c.take('b', 1, T + 60_000);
    expect(c.recheck('b', T + 60_000, 4, entry(c, 'b', T + 60_000, 4, 'no-data'))).toEqual({ ok: true });
  });
  it("a refund on the store-unavailable path: the release writes its entry armed, so the next settlement is held (r54)", () => {
    const c = core();
    c.release('su', T + 9_000, { outcome: 'sent', entry: { kind: 'no-data', marketId: 3, nonce: 4, calldataHash: '0xef' } });
    expect(c.s.journal[0]).toMatchObject({ writer: 'su', armedAt: T + 9_000 });
    c.take('b', 1, T + 60_000);
    expect(c.recheck('b', T + 60_000, 4, entry(c, 'b', T + 60_000, 4))).toEqual({ ok: false, reason: 'nonce-held' });
  });
  it('a refused re-check whose not_sent landed, then a refund sent anyway: the sent release clears it and arms (r55)', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4, 'no-data');
    expect(c.recheck('a', T + LEASE_MS - 10_000, 4, id)).toEqual({ ok: false, reason: 'time-left' });
    c.resultTurn('a', T + LEASE_MS - 9_000, { result: 'failed', entryId: id, notSent: true }); // timed out, but landed
    c.release('a', T + LEASE_MS - 1_000, { outcome: 'sent', entryId: id }); // the refund went out production's way
    expect(c.s.journal[0]).toMatchObject({ result: null, armedAt: T + LEASE_MS - 1_000 });
    c.take('b', 1, T + LEASE_MS + 60_000);
    expect(c.recheck('b', T + LEASE_MS + 60_000, 4, entry(c, 'b', T + LEASE_MS + 60_000, 4))).toEqual({ ok: false, reason: 'nonce-held' });
  });
  it('a sent release keeps the arming time of an entry its re-check armed (r55)', () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.recheck('a', T + 1000, 4, id);
    c.release('a', T + 400_000, { outcome: 'sent', entryId: id }); // landed very late
    expect(c.s.journal[0].armedAt).toBe(T + 1000);
  });
  it('a release from an older version writes nothing at all, not even its token (r55)', () => {
    const c = core();
    c.take('new', 5, T);
    c.release('new', T + 1, undefined, 5);
    const before = JSON.stringify(c.s);
    expect(c.release('old', T + 2, { outcome: 'sent', entry: { kind: 'no-data', marketId: 1, nonce: 4, calldataHash: '0x' } }, 4)).toBe(false);
    expect(c.release('bad', T + 3, undefined, Number.NaN)).toBe(false);
    expect(JSON.stringify(c.s)).toBe(before);
    expect(c.release('same', T + 4, undefined, 5)).toBe(false); // the current version is not older: its token is recorded
    expect(Object.keys(c.s.released)).toContain('t:same');
  });
  it("a release never changes an entry another token wrote (r54)", () => {
    const c = core();
    c.take('a', 1, T);
    const id = entry(c, 'a', T, 4);
    c.recheck('a', T + 1000, 4, id);
    c.release('x', T + 2000, { outcome: 'not-sent', entryId: id });
    expect(c.s.journal[0]).toMatchObject({ result: null, armedAt: T + 1000 });
    c.release('y', T + 3000, { outcome: 'sent', entryId: id });
    expect(c.s.journal[0].armedAt).toBe(T + 1000);
  });
});

describe('the queue (§4.9 Within a settlement turn)', () => {
  it('entrants take positions in (C, market id) order, before the turn candidate moves to the back', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 9, close: 200 }, { marketId: 3, close: 100 }, { marketId: 4, close: 100 }], gone: [] }, null);
    expect([3, 4, 9].map((id) => c.s.candidates[id].position)).toEqual([1, 2, 3]);
    c.startTurn('a', T + 1, { entrants: [{ marketId: 12, close: 50 }], gone: [] }, { kind: 'settlement', marketId: 3 });
    expect(c.s.candidates[12].position).toBe(4); // the entrant first
    expect(c.s.candidates[3].position).toBe(5); // then the turn's candidate, at the back
    expect(c.head()!.marketId).toBe(4);
  });
  it('N + 1: a candidate with N undemoted ahead of it is attempted within N + 1 settlement turns', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [1, 2, 3].map((id) => ({ marketId: id, close: id })), gone: [] }, null);
    c.startTurn('a', T, { entrants: [{ marketId: 10, close: 999 }], gone: [] }, null); // 3 ahead of it
    const tried: number[] = [];
    for (let i = 0; i < 4; i++) {
      const h = c.head()!;
      tried.push(h.marketId);
      c.startTurn('a', T + i, { entrants: [], gone: [] }, { kind: 'settlement', marketId: h.marketId });
      c.resultTurn('a', T + i, { result: 'failed' });
      c.s.candidates[h.marketId].count = 0; // keep this test about ordering, not demotion
    }
    expect(tried).toEqual([1, 2, 3, 10]);
  });
  it('absence ends count, level and position; an unread market keeps them (r28, r29)', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 1, close: 1 }, { marketId: 2, close: 2 }], gone: [] }, null);
    c.startTurn('a', T + 1, { entrants: [], gone: [1] }, null); // 1 read and gone; 2 unread
    expect(c.s.candidates[1]).toBeUndefined();
    expect(c.s.candidates[2].position).toBe(2);
  });
});

describe('demotion (§4.9 Demotion)', () => {
  it('two counted turns demote at the next run start, with backoff 10 min doubling to 1 h; on return, count is 1', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, null);
    for (let i = 0; i < 2; i++) {
      c.startTurn('a', T + i, { entrants: [], gone: [] }, { kind: 'settlement', marketId: 5 });
      c.resultTurn('a', T + i, { result: 'failed' });
    }
    expect(c.demoteBatch('a', T + 10)).toEqual([5]);
    const m = c.s.candidates[5];
    expect([m.position, m.level, m.backoffEnd]).toEqual([null, 1, T + 10 + BACKOFF_BASE_MS]);
    expect(c.head()).toBeNull();
    // Back after the backoff, as an entry with count 1: one more counted turn demotes it again, at 20 minutes.
    // (A later run, so a fresh lease: the first one expired after 180 s.)
    c.release('a', T + 11);
    c.take('b', 1, T + 10 + BACKOFF_BASE_MS);
    c.startTurn('b', T + 10 + BACKOFF_BASE_MS, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    expect(m.count).toBe(2);
    c.resultTurn('b', T + 20 + BACKOFF_BASE_MS, { result: 'failed' });
    c.demoteBatch('b', T + 30 + BACKOFF_BASE_MS);
    expect(m.backoffEnd).toBe(T + 30 + BACKOFF_BASE_MS + 2 * BACKOFF_BASE_MS);
  });
  it('the backoff is capped at 1 hour', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, null);
    c.s.candidates[5].level = 9;
    c.s.candidates[5].count = 2;
    c.demoteBatch('a', T);
    expect(c.s.candidates[5].backoffEnd).toBe(T + BACKOFF_CAP_MS);
  });
  it('a decision-storing turn does not count (r27)', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    c.resultTurn('a', T, { result: 'stored-ready' });
    expect(c.s.candidates[5].count).toBe(0);
  });
});

describe('turns and holds (§4.9 Turns)', () => {
  it('alternates kinds when both wait, counted from turn starts', () => {
    const c = core();
    expect(c.chooseKind(true, true)).toBe('no-data');
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 1 });
    expect(c.chooseKind(true, true)).toBe('settlement');
    expect(c.chooseKind(true, false)).toBe('no-data');
  });
  it('a nonce hold voids the turn: position, count and lastTurn restored, entrants kept (r47, r48)', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'no-data', marketId: 99 });
    c.resultTurn('a', T, { result: 'sent' });
    const before = { ...c.s.candidates[5] };
    c.startTurn('a', T + 60_000, { entrants: [{ marketId: 6, close: 2 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    c.resultTurn('a', T + 60_000, { result: 'nonce-hold' });
    expect(c.s.candidates[5]).toEqual(before);
    expect(c.s.candidates[6].position).toBe(2); // the entrant stands
    expect(c.s.lastTurn).toEqual({ kind: 'no-data', marketId: 99, result: 'sent' }); // retry the same kind next
  });
  it('an out-of-funds hold restores position and count but moves to the other kind (r48)', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    c.resultTurn('a', T, { result: 'out-of-funds' });
    expect(c.s.candidates[5]).toMatchObject({ position: 1, count: 0 });
    expect(c.chooseKind(true, true)).toBe('no-data');
  });
  it('the result transaction records the hash and a not_sent refusal on the journal entry', () => {
    const c = core();
    c.take('a', 1, T);
    c.startTurn('a', T, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 1 });
    const id = c.journalEntry('a', T, { kind: 'no-data', marketId: 1, nonce: 3, calldataHash: '0x' });
    c.resultTurn('a', T + 1, { result: 'sent', entryId: id, txHash: '0xhash' });
    expect(c.s.journal[0]).toMatchObject({ txHash: '0xhash', result: null });
    const id2 = c.journalEntry('a', T + 2, { kind: 'no-data', marketId: 1, nonce: 4, calldataHash: '0x' });
    c.resultTurn('a', T + 3, { result: 'failed', entryId: id2, notSent: true });
    expect(c.s.journal[1].result).toBe('not_sent');
  });
});
