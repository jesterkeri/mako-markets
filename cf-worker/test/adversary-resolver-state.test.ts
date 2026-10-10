// Adversary pass on ResolverState's core (src/resolver-state.ts at ab8d9c7) against RESOLVER_PRICE_PLAN r51 §4.9.
// Each case follows the plan's own call order and asserts what the plan requires. Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import { emptyState, ResolverStateCore } from '../src/resolver-state';

const T = 1_000_000;

describe('adversary: ResolverState core vs plan r51 §4.9', () => {
  // §4.9 Lease and timing: "... the journal entry and evidence writes (2 s each), **then** the lease re-check (2 s,
  // the last store call, r41), **then** the raw send". §4.9 Turns: the re-check holds on an entry "whose nonce is at
  // least the nonce this send would use"; "later turns held by its entry are voided". The hold is for entries of
  // EARLIER turns; the send's own entry, written just before its re-check, cannot hold the send that wrote it.
  it("a send's own journal entry, written before its re-check as the plan orders them, does not hold that send", () => {
    const c = new ResolverStateCore(emptyState());
    expect(c.take('run', 1, T)).toBe('granted');
    c.startTurn('run', T, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 1 });
    // No earlier entry exists at all: the journal is empty before this turn's own entry.
    const own = c.journalEntry('run', T + 30_000, { kind: 'no-data', marketId: 1, nonce: 7, calldataHash: '0xab' });
    // The own entry's id is passed too, so a fix that identifies the turn's entry by id still meets this test.
    const recheck = c.recheck as unknown as (t: string, now: number, nonce: number, entryId?: number) => unknown;
    expect(recheck.call(c, 'run', T + 34_000, 7, own)).toEqual({ ok: true });
  });

  // §4.9 Lease and timing: "the lease take is a conditional write (r44): the store compares the run's version first
  // and, for an older one, writes nothing, grants no lease and answers `older`; **otherwise it records the version**
  // and the store keeps the newest seen." A newer run that finds the lease held is not older, so its version is
  // recorded; a later run of the older version must then be refused (r43: "a stale version can neither send a price
  // settlement nor change the store").
  it('a newer version that finds the lease held is still recorded, so the older version is refused afterwards', () => {
    const c = new ResolverStateCore(emptyState());
    expect(c.take('v4-run1', 4, T)).toBe('granted');
    expect(c.take('v5-run1', 5, T + 60_000)).toBe('held'); // v5 deployed; v4's slow run still holds the lease
    c.release('v4-run1', T + 90_000);
    expect(c.take('v4-run2', 4, T + 120_000)).toBe('older');
  });

  // File header: "The Durable Object that hosts it wraps each method below in ONE storage transaction; nothing here
  // awaits, so each method is all-or-nothing." A start transaction that is refused must leave the state untouched;
  // otherwise the in-memory core diverges from what the storage transaction rolled back.
  it('a refused start transaction (turn for a demoted market) changes nothing', () => {
    const c = new ResolverStateCore(emptyState());
    c.take('run', 1, T);
    c.startTurn('run', T, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, null);
    c.s.candidates[5].count = 2;
    c.demoteBatch('run', T + 1); // 5 is now under backoff
    const before = JSON.stringify(c.s);
    expect(() =>
      c.startTurn('run', T + 2, { entrants: [{ marketId: 8, close: 3 }], gone: [] }, { kind: 'settlement', marketId: 5 }),
    ).toThrow();
    expect(JSON.stringify(c.s)).toBe(before);
  });
});
