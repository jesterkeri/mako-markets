// Adversary on eda38c7 (unit b): a PROVEN 1m row that a later fetch turns into a same-second conflict.
// CHARTS_DS_PLAN 3.5 step 4: "When a stored row becomes `conflict`, the `conflicts` table gets kind =
// 'refetch_mismatch' with both `raw_fp`s, `n_raw`s and `rules_version`s"; and for proven evidence "same raw_rule,
// different raw_fp -> conflict (refetch_mismatch): the raw comparison does not depend on rules". 3.3: raw_fp covers
// EVERY fetched entry, valid or not, so a re-fetch that adds a second report at an already proven second changes
// raw_fp exactly as a re-fetch that loses one does (merge.test.ts covers the loss and gets refetch_mismatch).
// Real page open-minute-BTC (2026-10-15 15:00 UTC); derived, as merge.test.ts does: one extra report at M + 7 whose
// price word is changed (withWord), so two different valid reports share that second.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { buildMinute, type MinuteRow } from '../src/candle';
import { candleWrites, readHoursOfDays, readMinutesOfHours } from '../src/db';
import type { PageEntry } from '../src/entry';
import { planTick, touchedDays, touchedHours } from '../src/plan';
import { capture, feed, obsOf, withWord } from './helpers';

const BTC = feed('BTC');
const M = 1792076400;
const page = capture('open-minute-BTC');
const FAR = 2_000_000_000;
const db = () => env.DB;

const twin = (src: PageEntry[], s: number) => {
  const e = src.find((x) => obsOf(x) === s)!;
  return withWord(e, 6, 1n + BigInt(String((e as Record<string, unknown>).observationsTimestamp)));
};

async function tick(built: MinuteRow[]) {
  const [m, h] = await Promise.all([readMinutesOfHours(db(), touchedHours(built)), readHoursOfDays(db(), touchedDays(built))]);
  await db().batch(candleWrites(db(), planTick(built, m, h, FAR)));
}

describe('proven row, then a re-fetch whose raw bytes gained a same-second twin', () => {
  it('keeps both raw fingerprints as refetch_mismatch evidence (the proven one is not erased)', async () => {
    const proven = buildMinute(BTC, M, page);
    const later = buildMinute(BTC, M, [...page, twin(page, M + 7)]);
    expect(proven.state).toBe('open');
    expect(later.state).toBe('conflict');
    expect(later.raw_rule).toBe(proven.raw_rule);
    expect(later.raw_fp).not.toBe(proven.raw_fp);

    await tick([proven]); // the open candle is stored and served
    await tick([later]); // the stored row becomes conflict

    const ev = (await db().prepare('SELECT kind, raw_fp_old, raw_fp_new FROM conflicts').all<Record<string, unknown>>()).results;
    expect(ev).toContainEqual({ kind: 'refetch_mismatch', raw_fp_old: proven.raw_fp, raw_fp_new: later.raw_fp });
  });
});
