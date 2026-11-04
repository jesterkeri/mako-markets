// CHARTS_DS_PLAN 3.5 step 4: every cell of the precedence table, from real captured pages (15.2 j, o). Cases a capture
// never showed change ONE thing of a real page and say which ("derived"): an entry removed, a report's price word
// changed (withWord, so two different valid reports share a second), or a stored row written by another build.
import { describe, expect, it } from 'vitest';

import { buildMinute, type MinuteRow } from '../src/candle';
import type { PageEntry } from '../src/entry';
import { isProven, mergeMinute, toStored, type StoredMinute } from '../src/merge';
import { capture, feed, obsOf, probePage, withWord } from './helpers';

const BTC = feed('BTC');
const EUR = feed('EURUSD');
const M = 1792076400; // open-minute-BTC: 2026-10-15 15:00 UTC
const W = 1791633600; // weekend-EURUSD: 2026-10-10 12:00 UTC, closed
const page = capture('open-minute-BTC');
const weekend = capture('weekend-EURUSD');

const open = () => buildMinute(BTC, M, page);
/// derived: every entry at or after M + 60 removed, so no exhaustion witness.
const incomplete = () => buildMinute(BTC, M, page.filter((e) => obsOf(e) < M + 60));
/// derived: a second report at M + 7 whose price word (v3 word 6) is changed by one.
const twin = (src: PageEntry[], s: number, wordIx: number) => {
  const e = src.find((x) => obsOf(x) === s)!;
  return withWord(e, wordIx, 1n + BigInt(String((e as Record<string, unknown>).observationsTimestamp)));
};
const conflictOf = (src: PageEntry[], f: typeof BTC, m: number, s: number, wordIx: number) => buildMinute(f, m, [...src, twin(src, s, wordIx)]);
/// derived: the entry at M + 20 removed (a re-fetch that lost one report).
const minusOne = () => buildMinute(BTC, M, page.filter((e) => obsOf(e) !== M + 20));
const stored = (r: MinuteRow, patch: Partial<StoredMinute> = {}): StoredMinute => ({ ...toStored(r, 0), ...patch });

describe('fixtures behave as the table needs', () => {
  it('open, incomplete, conflict, closed, empty from real pages', () => {
    expect(open().state).toBe('open');
    expect(incomplete().state).toBe('incomplete');
    expect(conflictOf(page, BTC, M, M + 7, 6).state).toBe('conflict');
    expect(buildMinute(EUR, W, weekend).state).toBe('closed');
    expect(conflictOf(weekend, EUR, W, W + 7, 7).state).toBe('conflict');
    expect(buildMinute(BTC, 1789734840, probePage('page-BTC')).state).toBe('empty');
    expect(minusOne().state).toBe('open');
    expect(minusOne().raw_fp).not.toBe(open().raw_fp);
  });
});

describe('row: none', () => {
  it('incomplete -> write incomplete with tries 1', () => {
    const m = mergeMinute(null, incomplete());
    expect(m.event).toBe('new');
    expect(m.write).toMatchObject({ state: 'incomplete', tries: 1, fp: null, raw_fp: null });
  });
  it('proven -> write', () => {
    const m = mergeMinute(null, open());
    expect(m.event).toBe('new');
    expect(m.write).toEqual(toStored(open(), 0));
    expect(m.becameConflict).toBe(false);
  });
  it('conflict -> write conflict with same_second evidence', () => {
    const c = conflictOf(page, BTC, M, M + 7, 6);
    const m = mergeMinute(null, c);
    expect(m.write?.state).toBe('conflict');
    expect(m.write?.o).toBeNull();
    expect(m.becameConflict).toBe(true);
    expect(m.evidence).toEqual([expect.objectContaining({ kind: 'same_second', minute: M, obs: M + 7, keccak_a: c.conflicts[0].keccakA, keccak_b: c.conflicts[0].keccakB, rules_version_new: c.rules_version, raw_fp_old: null, fp_old: null, rules_version_old: null })]);
  });
});

describe('row: incomplete', () => {
  it('incomplete -> keep, tries + 1', () => {
    const m = mergeMinute(stored(incomplete(), { tries: 2 }), incomplete());
    expect(m.event).toBe('retry');
    expect(m.write).toMatchObject({ state: 'incomplete', tries: 3 });
  });
  it('proven -> write, tries kept as history', () => {
    const m = mergeMinute(stored(incomplete(), { tries: 2 }), open());
    expect(m.event).toBe('proved');
    expect(m.write).toEqual(toStored(open(), 2));
  });
  it('conflict -> write', () => {
    const m = mergeMinute(stored(incomplete()), conflictOf(page, BTC, M, M + 7, 6));
    expect(m.write?.state).toBe('conflict');
    expect(m.becameConflict).toBe(true);
  });
});

describe('row: proven', () => {
  it.each([
    ['open', () => open()],
    ['closed', () => buildMinute(EUR, W, weekend)],
    ['empty', () => buildMinute(BTC, 1789734840, probePage('page-BTC'))],
  ])('%s, then incomplete -> keep (a failed collection is not evidence)', (_n, make) => {
    const s = make();
    const f = s.symbol === 'BTC' && s.t === M ? incomplete() : buildMinute(feed(s.symbol), s.t, []);
    expect(f.state).toBe('incomplete');
    const m = mergeMinute(stored(s), f);
    expect(m.event).toBe('kept');
    expect(m.write).toBeNull();
  });

  it('open, then a same-second conflict -> conflict, OHLC gone', () => {
    const m = mergeMinute(stored(open()), conflictOf(page, BTC, M, M + 7, 6));
    expect(m.event).toBe('conflict');
    expect(m.write).toMatchObject({ state: 'conflict', o: null, h: null, l: null, c: null });
    expect(m.becameConflict).toBe(true);
    expect(m.evidence[0]).toMatchObject({ kind: 'same_second', fp_old: null, raw_fp_old: null, raw_fp_new: conflictOf(page, BTC, M, M + 7, 6).raw_fp });
    // The same-second evidence is what a fresh conflict records; the proven row's re-fetch adds a refetch record with
    // both raw fingerprints (plan 3.5 step 4).
    const fresh = mergeMinute(null, conflictOf(page, BTC, M, M + 7, 6)).evidence;
    expect(m.evidence.slice(0, fresh.length)).toEqual(fresh);
    expect(m.evidence.slice(fresh.length)).toEqual([
      expect.objectContaining({ kind: 'refetch_mismatch', raw_fp_old: open().raw_fp, raw_fp_new: conflictOf(page, BTC, M, M + 7, 6).raw_fp }),
    ]);
  });

  it('closed, then a same-second conflict -> conflict', () => {
    const m = mergeMinute(stored(buildMinute(EUR, W, weekend)), conflictOf(weekend, EUR, W, W + 7, 7));
    expect(m.write?.state).toBe('conflict');
    expect(m.becameConflict).toBe(true);
  });

  it('open, then a re-fetch with one report missing (different raw_fp, same rules) -> conflict refetch_mismatch', () => {
    const m = mergeMinute(stored(open()), minusOne());
    expect(m.event).toBe('conflict');
    expect(m.write).toMatchObject({ state: 'conflict', o: null, h: null, l: null, c: null, open_obs: null, close_obs: null, n_open: 0, fp: open().fp, raw_fp: open().raw_fp });
    expect(m.evidence).toEqual([
      expect.objectContaining({ kind: 'refetch_mismatch', minute: M, obs: null, raw_fp_old: open().raw_fp, raw_fp_new: minusOne().raw_fp, n_raw_old: 60, n_raw_new: 59, fp_old: open().fp, fp_new: minusOne().fp }),
    ]);
  });

  it('different raw_fp under different rules is still a conflict (the raw comparison does not depend on rules)', () => {
    const m = mergeMinute(stored(open(), { rules_version: 'previous-build' }), minusOne());
    expect(m.event).toBe('conflict');
    expect(m.evidence[0]).toMatchObject({ kind: 'refetch_mismatch', rules_version_old: 'previous-build', rules_version_new: open().rules_version });
  });

  it('same raw bytes, same rules, same result -> identical, nothing written', () => {
    const m = mergeMinute(stored(open()), open());
    expect(m.event).toBe('identical');
    expect(m.write).toBeNull();
    expect(m.evidence).toEqual([]);
  });

  it('same raw bytes under another rules_version -> reinterpreted, replaced, not a conflict (derived: stored by another build)', () => {
    const old = stored(open(), { rules_version: 'previous-build', state: 'stale', o: null, h: null, l: null, c: null, n_open: 0 });
    const m = mergeMinute(old, open());
    expect(m.event).toBe('reinterpreted');
    expect(m.write).toEqual(toStored(open(), 0));
    expect(m.evidence).toEqual([]);
    expect(m.becameConflict).toBe(false);
  });

  it('another raw_rule -> reinterpreted, even with a different raw_fp', () => {
    const m = mergeMinute(stored(open(), { raw_rule: 0, raw_fp: '0xdead' }), open());
    expect(m.event).toBe('reinterpreted');
    expect(m.write?.state).toBe('open');
  });

  it('same raw bytes and rules but a different stored result -> internal_mismatch, stored row kept', () => {
    for (const patch of [{ o: '1' }, { fp: '0x01' }, { n_open: 59 }, { state: 'closed' as const, o: null, h: null, l: null, c: null }]) {
      const m = mergeMinute(stored(open(), patch), open());
      expect(m.event).toBe('internal_mismatch');
      expect(m.write).toBeNull();
    }
  });

  it('n_rejected alone differing is not a mismatch (it also counts other feeds\' entries, which raw_fp does not cover)', () => {
    const m = mergeMinute(stored(open(), { n_rejected: 0 }), { ...open(), n_rejected: 2 });
    expect(m.event).toBe('identical');
    expect(m.rejectedNew).toBe(2);
  });
});

describe('row: conflict (sticky)', () => {
  const stuck = () => stored(conflictOf(page, BTC, M, M + 7, 6));

  it('incomplete -> keep', () => {
    expect(mergeMinute(stuck(), incomplete())).toMatchObject({ event: 'kept', write: null, evidence: [] });
  });
  it('a later single-view proven fetch does not clear it, and adds refetch evidence', () => {
    const m = mergeMinute(stuck(), open());
    expect(m.event).toBe('kept');
    expect(m.write).toBeNull();
    expect(m.evidence).toEqual([expect.objectContaining({ kind: 'refetch_mismatch', raw_fp_old: stuck().raw_fp, raw_fp_new: open().raw_fp })]);
  });
  it('a proven fetch with the same raw bytes adds nothing', () => {
    expect(mergeMinute(stored(open(), { state: 'conflict', o: null, h: null, l: null, c: null }), open())).toMatchObject({ event: 'kept', evidence: [] });
  });
  it('a proven fetch under another raw_rule adds nothing (not comparable)', () => {
    expect(mergeMinute({ ...stuck(), raw_rule: 0 }, open()).evidence).toEqual([]);
  });
  it('conflict -> keep, add the same-second evidence', () => {
    const m = mergeMinute(stuck(), conflictOf(page, BTC, M, M + 7, 6));
    expect(m.event).toBe('kept');
    expect(m.write).toBeNull();
    expect(m.becameConflict).toBe(false);
    expect(m.evidence).toHaveLength(1);
  });
});

describe('carry-forward: n_rejected on incomplete minutes and runs.rejected', () => {
  /// derived: the entry at M + 10 replaced by one whose fullReport is not hex (invalid, same feed, same second).
  const bad = page.map((e) => (obsOf(e) === M + 10 ? { ...e, fullReport: 'not hex' } : e));
  const badIncomplete = () => buildMinute(BTC, M, bad.filter((e) => obsOf(e) < M + 60));
  const badProven = () => buildMinute(BTC, M, bad);

  it('an incomplete minute keeps n_rejected while n_raw stays 0, and is stored as is', () => {
    const r = badIncomplete();
    expect(r).toMatchObject({ state: 'incomplete', n_rejected: 1, n_raw: 0 });
    expect(mergeMinute(null, r).write).toMatchObject({ state: 'incomplete', n_rejected: 1, n_raw: 0 });
    expect(mergeMinute(null, r).rejectedNew).toBe(1);
  });

  it('every retry of the same incomplete minute adds 0 to runs.rejected', () => {
    let s = mergeMinute(null, badIncomplete()).write!;
    let total = 1;
    for (let i = 0; i < 5; i++) {
      const m = mergeMinute(s, badIncomplete());
      total += m.rejectedNew;
      s = m.write!;
    }
    expect(total).toBe(1);
    expect(s).toMatchObject({ tries: 6, n_rejected: 1 });
  });

  it('the proving fetch of a retried minute adds only what is new', () => {
    const s = mergeMinute(null, badIncomplete()).write!;
    const m = mergeMinute(s, badProven());
    expect(m.write).toMatchObject({ state: 'open', n_rejected: 1 });
    expect(m.rejectedNew).toBe(0);
  });

  it('a retry that sees more rejected entries adds the difference, and the kept row stores the larger count', () => {
    const s = mergeMinute(null, badIncomplete()).write!;
    /// derived: a second entry (M + 11) made invalid the same way.
    const worse = buildMinute(BTC, M, bad.filter((e) => obsOf(e) < M + 60).map((e) => (obsOf(e) === M + 11 ? { ...e, fullReport: 'not hex' } : e)));
    const m = mergeMinute(s, worse);
    expect(m.rejectedNew).toBe(1);
    expect(m.write).toMatchObject({ n_rejected: 2, tries: 2 });
    const back = mergeMinute(m.write, badIncomplete());
    expect(back.rejectedNew).toBe(0);
    expect(back.write).toMatchObject({ n_rejected: 2 });
  });
});

describe('guards', () => {
  it('refuses to merge rows of different minutes or feeds', () => {
    expect(() => mergeMinute(stored(open(), { t: M + 60 }), open())).toThrow();
    expect(() => mergeMinute(stored(open(), { feed: 'ETH' }), open())).toThrow();
  });
  it('isProven is exactly the five proven states', () => {
    expect((['open', 'closed', 'empty', 'stale', 'unknown', 'incomplete', 'conflict'] as const).filter(isProven)).toEqual(['open', 'closed', 'empty', 'stale', 'unknown']);
  });
});
