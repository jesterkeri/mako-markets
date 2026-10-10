// Adversary pass r2 on ResolverState (RESOLVER_PRICE_PLAN r52 §4.9, commit 4852108). Each case quotes the plan line
// it holds the store to, and drives the pure core in the order the plan prescribes. Times are the store's clock in ms.
import { describe, expect, it } from 'vitest';

import { emptyState, ResolverStateCore } from '../src/resolver-state';

const T = 1_000_000;
const MIN = 60_000;

describe('adversary r2: ResolverState', () => {
  // §3 step 0: "an out-of-funds hold moves to the other kind so a refund the wallet can pay for is not starved".
  // §4.9 Turns (b): "an out-of-funds hold, learned from the raw send's error, voids the turn without restoring
  // `lastTurn` (the next tick tries the other kind, so a refund the wallet can still pay for is not starved)".
  // §4.9 Tests (r48): "a wallet that can pay for refunds but not settlements (refunds keep their turns)".
  // An out-of-funds error comes from the raw send, which runs only after a PASSING re-check, so the settlement's
  // entry is armed (r52). Nothing reached the pool, nothing in the plan closes the entry, and the refund at the same
  // nonce (nothing was consumed) is then held by it for 345 s, every settlement turn.
  it('an out-of-funds settlement send does not hold the next tick\'s refund at the same nonce', () => {
    const c = new ResolverStateCore(emptyState());
    const nonce = 40;

    // Tick 0: a refund at nonce 39 is sent and lands (reconciled), so lastTurn is no-data.
    expect(c.take('r0', 1, T - MIN)).toBe('granted');
    c.startTurn('r0', T - MIN, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 99 });
    const r0 = c.journalEntry('r0', T - MIN + 5_000, { kind: 'no-data', marketId: 99, nonce: nonce - 1, calldataHash: '0x00' });
    expect(c.recheck('r0', T - MIN + 7_000, nonce - 1, r0)).toEqual({ ok: true });
    c.resultTurn('r0', T - MIN + 15_000, { result: 'sent', entryId: r0, txHash: '0xaa' });
    c.release('r0', T - MIN + 16_000);

    // Tick 1: pool 5 enters and both kinds wait, so this is a settlement turn; pool 5 is the only one queued.
    expect(c.take('r1', 1, T)).toBe('granted');
    c.reconcile('r1', T + 500, r0, 'confirmed');
    expect(c.chooseKind(true, true)).toBe('settlement');
    c.startTurn('r1', T + 1_000, { entrants: [{ marketId: 5, close: 1 }], gone: [] }, { kind: 'settlement', marketId: 5 });
    const settle = c.journalEntry('r1', T + 50_000, { kind: 'settlement', marketId: 5, nonce, calldataHash: '0x01' });
    expect(c.recheck('r1', T + 52_000, nonce, settle)).toEqual({ ok: true });
    // Raw send answers insufficient funds: the result transaction records the out-of-funds hold.
    c.resultTurn('r1', T + 61_000, { result: 'out-of-funds', entryId: settle });
    c.release('r1', T + 62_000);

    // Tick 2: the other kind, a refund the wallet can pay for, at the same nonce.
    expect(c.take('r2', 1, T + MIN)).toBe('granted');
    expect(c.chooseKind(true, true)).toBe('no-data');
    c.startTurn('r2', T + MIN + 1_000, { entrants: [], gone: [] }, { kind: 'no-data', marketId: 77 });
    const refund = c.journalEntry('r2', T + MIN + 5_000, { kind: 'no-data', marketId: 77, nonce, calldataHash: '0x02' });
    expect(c.recheck('r2', T + MIN + 7_000, nonce, refund)).toEqual({ ok: true });
  });

  // §4.9 Lease and timing: "the store compares the run's version first and, for an older one, writes nothing ...;
  // otherwise it records the version and the store keeps the newest seen" and r43: "a stale version can neither send
  // a price settlement nor change the store". The version is the version_metadata `timestamp`, read by each run; the
  // plan itself flags that its presence in scheduled() is unconfirmed. A run whose timestamp parses to NaN must not
  // erase the newest version seen.
  it('a malformed version (NaN) does not erase the newest version seen', () => {
    const c = new ResolverStateCore(emptyState());
    expect(c.take('v5', 5, T)).toBe('granted');
    c.release('v5', T + 1_000);
    c.take('bad', Number.NaN, T + MIN); // whatever it answers, it is not a newer version
    c.release('bad', T + MIN + 1_000);
    expect(c.take('v4', 4, T + 2 * MIN)).toBe('older');
  });

  // §4.9 Lease: "the store refuses a take whose token was already released ... whatever order one run's calls
  // arrive in". The existing suite already guards inherited names on the take; this is the write side.
  it('a released token is refused whatever its text', () => {
    const c = new ResolverStateCore(emptyState());
    c.release('__proto__', T);
    expect(c.take('__proto__', 1, T + 1_000)).toBe('token-released');
  });
});
