// ResolverState's rules (RESOLVER_PRICE_PLAN r51 §4.9), spec-first: each case is written from the plan's text and run
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

describe('the re-check before the raw send (r41, r49, r51)', () => {
  it('needs 20 s of lease left', () => {
    const c = core();
    c.take('a', 1, T);
    expect(c.recheck('a', T + LEASE_MS - 20_000, 0)).toEqual({ ok: true });
    expect(c.recheck('a', T + LEASE_MS - 19_999, 0)).toEqual({ ok: false, reason: 'time-left' });
  });
  it('a journal entry holds its nonce 345 s from its write, hash or not; then it is presumed dropped and holds nothing', () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T, { kind: 'settlement', marketId: 7, nonce: 4, calldataHash: '0xab' });
    expect(c.recheck('a', T + 1000, 4)).toEqual({ ok: false, reason: 'nonce-held' }); // no hash yet: still holds
    expect(c.recheck('a', T + 1000, 5)).toEqual({ ok: true }); // a higher nonce is not held
    c.release('a', T + 2000);
    c.take('b', 1, T + NONCE_HOLD_MS - 1);
    expect(c.recheck('b', T + NONCE_HOLD_MS - 1, 4)).toEqual({ ok: false, reason: 'nonce-held' });
    c.release('b', T + NONCE_HOLD_MS);
    c.take('c', 1, T + NONCE_HOLD_MS);
    expect(c.recheck('c', T + NONCE_HOLD_MS, 4)).toEqual({ ok: true });
    expect(c.s.journal.find((e) => e.id === id)!.presumedDropped).toBe(true);
    expect(c.s.journal.find((e) => e.id === id)!.result).toBeNull(); // not final
  });
  it('a reconciled entry holds nothing', () => {
    const c = core();
    c.take('a', 1, T);
    const id = c.journalEntry('a', T, { kind: 'no-data', marketId: 1, nonce: 4, calldataHash: '0x' });
    c.reconcile('a', T + 10, id, 'confirmed');
    expect(c.recheck('a', T + 20, 4)).toEqual({ ok: true });
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
