import { describe, expect, it } from 'vitest';
import { advanceCursor, pageRequests, planScan, type ScanPlan } from '../src/scan';
import { ID_BUDGET } from '../src/config';
import type { MarketHead } from '../src/abi';

const head = (id: number): MarketHead => ({
  id, mType: 1, oracleRef: '0x' + '0'.repeat(64), createdAt: 1, closeTime: 2, bettingCloseTime: 2, totalYes: 0n, totalNo: 0n, resolved: false,
});

/// Reads for a plan where `failed` ids come back unread.
function readsFor(plan: ScanPlan, failed: Set<number> = new Set()): Map<number, MarketHead | null> {
  return new Map(plan.ids.map((id) => [id, failed.has(id) ? null : head(id)]));
}

describe('request ceilings (I1)', () => {
  it.each([
    [0, 0], [1, 1], [50, 1], [51, 1], [200, 1], [201, 2], [2000, 10], [2001, 10], [5000, 10],
  ])('N = %i reads at most 2,000 ids in %i page requests', (n, pages) => {
    const plan = planScan(n, 0, 7);
    expect(plan.ids.length).toBe(Math.min(n, ID_BUDGET));
    expect(new Set(plan.ids).size).toBe(plan.ids.length);
    expect(pageRequests(plan.ids).length).toBe(pages);
    expect(1 + pageRequests(plan.ids).length).toBeLessThanOrEqual(11);
  });
  it('in-envelope, every id below N is read whatever the cursor', () => {
    for (const [n, cursor] of [[86, 0], [86, 40], [86, 86], [2000, 1999], [2000, 0], [1500, 700]]) {
      const plan = planScan(n, cursor, 3);
      expect([...plan.ids].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });
});

describe('bounded contiguous prefix (review correction, 2026-09-19)', () => {
  it('5,000 ids from cursor 0: 0 -> 2,000 -> 4,000 -> 5,000, then all rotating', () => {
    const n = 5000;
    let cursor = 0;
    const expected = [
      { start: 0, end: 2000, rotating: 0, next: 2000 },
      { start: 2000, end: 4000, rotating: 0, next: 4000 },
      { start: 4000, end: 5000, rotating: 1000, next: 5000 },
      { start: 5000, end: 5000, rotating: 2000, next: 5000 },
    ];
    expected.forEach((e, run) => {
      const plan = planScan(n, cursor, run);
      expect(plan.prefixStart).toBe(e.start);
      expect(plan.prefixEnd).toBe(e.end);
      expect(plan.rotatingCount).toBe(e.rotating);
      expect(plan.ids.length).toBe(ID_BUDGET);
      // prefix first, in order
      expect(plan.ids.slice(0, e.end - e.start)).toEqual(Array.from({ length: e.end - e.start }, (_, i) => e.start + i));
      // rotating reads are outside the prefix and never move the cursor
      for (const id of plan.ids.slice(e.end - e.start)) expect(id < e.start || id >= e.end).toBe(true);
      cursor = advanceCursor(plan, readsFor(plan), null);
      expect(cursor).toBe(e.next);
    });
  });

  it('a failure at 2,345 in run 2 stops the cursor there; run 3 reads [2,345, 4,345)', () => {
    const n = 5000;
    let plan = planScan(n, 0, 0);
    let cursor = advanceCursor(plan, readsFor(plan), null);
    expect(cursor).toBe(2000);
    plan = planScan(n, cursor, 1);
    cursor = advanceCursor(plan, readsFor(plan, new Set([2345])), null);
    expect(cursor).toBe(2345);
    plan = planScan(n, cursor, 2);
    expect([plan.prefixStart, plan.prefixEnd]).toEqual([2345, 4345]);
    cursor = advanceCursor(plan, readsFor(plan), null);
    expect(cursor).toBe(4345);
  });

  it('a rotating read that fails does not hold the cursor; a rotating read never advances it', () => {
    const n = 5000;
    const plan = planScan(n, 4000, 9);
    const rotatingFail = plan.ids.slice(1000, 1010);
    expect(advanceCursor(plan, readsFor(plan, new Set(rotatingFail)), null)).toBe(5000);
    const onlyRotating = new Map(plan.ids.slice(1000).map((id) => [id, head(id)] as const));
    expect(advanceCursor(plan, onlyRotating, null)).toBe(4000);
  });

  it('stops at the first id whose creation alert was not confirmed', () => {
    const plan = planScan(86, 80, 0);
    expect(advanceCursor(plan, readsFor(plan), 83)).toBe(83);
    expect(advanceCursor(plan, readsFor(plan), null)).toBe(86);
  });

  it('a first failed page leaves the cursor at its first id', () => {
    const plan = planScan(300, 0, 0);
    const failed = new Set(Array.from({ length: 200 }, (_, i) => 200 + i).filter((id) => id < 300));
    expect(advanceCursor(plan, readsFor(plan, failed), null)).toBe(200);
  });

  it('N reported below the stored cursor never moves it backwards', () => {
    const plan = planScan(80, 86, 0);
    expect(plan.prefixStart).toBe(80);
    expect(advanceCursor(plan, readsFor(plan), null)).toBe(86);
  });

  it('property: over random failures and growth, the cursor never passes an unread id and every id is checked', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 40; trial++) {
      let n = Math.floor(rand() * 3000);
      let cursor = 0;
      const checked = new Set<number>();
      for (let run = 0; run < 60; run++) {
        n += Math.floor(rand() * 40);
        const plan = planScan(n, cursor, run);
        const failed = new Set(plan.ids.filter(() => rand() < 0.01));
        const reads = readsFor(plan, failed);
        const stopAt = rand() < 0.1 && plan.prefixEnd > plan.prefixStart ? plan.prefixStart + Math.floor(rand() * (plan.prefixEnd - plan.prefixStart)) : null;
        const next = advanceCursor(plan, reads, stopAt);
        for (let id = cursor; id < next; id++) {
          expect(reads.get(id)).toBeTruthy(); // never past an unread id
          if (stopAt !== null) expect(id).toBeLessThan(stopAt);
          checked.add(id);
        }
        expect(next).toBeGreaterThanOrEqual(cursor);
        cursor = next;
      }
      for (let id = 0; id < cursor; id++) expect(checked.has(id)).toBe(true);
    }
  });
});
