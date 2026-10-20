// ----------------------------------------------------------------------------
// price-recorder/src/merge.ts
//
// What a freshly built 1m row may change in the stored one (CHARTS_DS_PLAN 3.5 step 4, the precedence table). Pure.
// "Proven" = exhausted by a witness (3.4): open, closed, empty, stale, unknown. Rows = stored, columns = this fetch:
//
//   stored \ new   incomplete             proven                        conflict (same second, this fetch)
//   none           write incomplete       write                         write
//   incomplete     keep, tries + 1        write                         write
//   proven         keep                   compare (below)               conflict
//   conflict       keep                   keep (+ evidence if raw_fp    keep, add evidence
//                                         differs under one RAW_RULE)
//
// Proven over proven:
//   different raw_rule                      -> reinterpreted (raw evidence not comparable): replace
//   same raw_rule, different raw_fp         -> conflict (refetch_mismatch), whatever the rules_version
//   same raw_rule, same raw_fp, other rules -> reinterpreted: replace
//   same raw_rule, same raw_fp, same rules  -> identical: no change. If the row differs anyway that is impossible for
//                                              a pure function: internal_mismatch, the stored row is kept.
//
// Carry-forward from unit (a)'s review: an incomplete row keeps its n_rejected while n_raw stays 0, and a retry of an
// incomplete minute must not count the same rejected entries again in the tick's `runs.rejected`. `rejectedNew` is
// what this fetch adds to that total: its own n_rejected minus what the stored row already counted, never below 0. A
// kept incomplete row stores the larger of the two counts, so the next retry compares against the larger one.
// ----------------------------------------------------------------------------

import type { Conflict, MinuteRow, MinuteState } from './candle';

/// A candles_1m row as stored (plan 5.2). `feed` is the symbol.
export type StoredMinute = {
  feed: string;
  t: number;
  state: MinuteState;
  o: string | null;
  h: string | null;
  l: string | null;
  c: string | null;
  n_reports: number;
  n_open: number;
  n_rejected: number;
  open_obs: number | null;
  close_obs: number | null;
  max_stale_s: number | null;
  fp: string | null;
  n_valid: number;
  raw_fp: string | null;
  n_raw: number;
  raw_rule: number;
  rules_version: string;
  tries: number;
};

/// A conflicts row (plan 5.2) without `seen_at`, which the database stamps.
export type ConflictEvidence = {
  feed: string;
  kind: 'same_second' | 'refetch_mismatch';
  minute: number;
  obs: number | null;
  keccak_a: string | null;
  keccak_b: string | null;
  fp_old: string | null;
  fp_new: string | null;
  n_valid_old: number | null;
  n_valid_new: number | null;
  raw_fp_old: string | null;
  raw_fp_new: string | null;
  n_raw_old: number | null;
  n_raw_new: number | null;
  rules_version_old: string | null;
  rules_version_new: string | null;
};

export type MergeEvent = 'new' | 'retry' | 'proved' | 'kept' | 'identical' | 'reinterpreted' | 'conflict' | 'internal_mismatch';

export type MinuteMerge = {
  /// The row to upsert, or null when the stored row stays as it is.
  write: StoredMinute | null;
  event: MergeEvent;
  evidence: ConflictEvidence[];
  /// The minute is a conflict now and was not before (a stored conflict is sticky and never written again, so every
  /// written conflict is a new one): the caller drops `latest` if it lies in this minute (8.2).
  becameConflict: boolean;
  /// What this fetch adds to the tick's `runs.rejected` (see the header).
  rejectedNew: number;
};

const PROVEN: ReadonlySet<MinuteState> = new Set(['open', 'closed', 'empty', 'stale', 'unknown']);
export const isProven = (s: MinuteState): boolean => PROVEN.has(s);

/// The stored form of a freshly built row.
export function toStored(row: MinuteRow, tries: number): StoredMinute {
  return {
    feed: row.symbol,
    t: row.t,
    state: row.state,
    o: row.o,
    h: row.h,
    l: row.l,
    c: row.c,
    n_reports: row.n_reports,
    n_open: row.n_open,
    n_rejected: row.n_rejected,
    open_obs: row.open_obs,
    close_obs: row.close_obs,
    max_stale_s: row.max_stale_s,
    fp: row.fp,
    n_valid: row.n_valid,
    raw_fp: row.raw_fp,
    n_raw: row.n_raw,
    raw_rule: row.raw_rule,
    rules_version: row.rules_version,
    tries,
  };
}

/// The fields a pure builder must reproduce from the same raw bytes under the same rules. n_rejected is left out: it
/// also counts entries of another feed and malformed feed ids, which raw_fp does not cover, so it can differ between
/// two fetches without any determinism bug.
const DETERMINED = ['state', 'o', 'h', 'l', 'c', 'n_reports', 'n_open', 'open_obs', 'close_obs', 'max_stale_s', 'fp', 'n_valid', 'n_raw'] as const;
const sameResult = (a: StoredMinute, b: StoredMinute): boolean => DETERMINED.every((k) => a[k] === b[k]);

/// A same-second pair is evidence about this fetch alone: the two keccaks, the second, and the fetch that saw them
/// (its fingerprints and the rules_version that judged both reports valid). Nothing of the stored row goes in, so the
/// same pair seen again by a later fetch of the same bytes is the same evidence and is stored once (db.ts).
function sameSecond(feed: string, t: number, fresh: MinuteRow, pairs: readonly Conflict[]): ConflictEvidence[] {
  return pairs.map((p) => ({
    feed,
    kind: 'same_second' as const,
    minute: t,
    obs: p.obs,
    keccak_a: p.keccakA,
    keccak_b: p.keccakB,
    fp_old: null,
    fp_new: fresh.fp,
    n_valid_old: null,
    n_valid_new: fresh.n_valid,
    raw_fp_old: null,
    raw_fp_new: fresh.raw_fp,
    n_raw_old: null,
    n_raw_new: fresh.n_raw,
    rules_version_old: null,
    rules_version_new: fresh.rules_version,
  }));
}

function refetch(stored: StoredMinute, fresh: MinuteRow): ConflictEvidence {
  return {
    feed: stored.feed,
    kind: 'refetch_mismatch',
    minute: stored.t,
    obs: null,
    keccak_a: null,
    keccak_b: null,
    fp_old: stored.fp,
    fp_new: fresh.fp,
    n_valid_old: stored.n_valid,
    n_valid_new: fresh.n_valid,
    raw_fp_old: stored.raw_fp,
    raw_fp_new: fresh.raw_fp,
    n_raw_old: stored.n_raw,
    n_raw_new: fresh.n_raw,
    rules_version_old: stored.rules_version,
    rules_version_new: fresh.rules_version,
  };
}

/// A proven row turned into a conflict by a later fetch: its OHLC is dropped (never drawn from contradicted
/// evidence); its own fingerprints stay, so the evidence it was proven on is kept.
const poisoned = (s: StoredMinute): StoredMinute => ({ ...s, state: 'conflict', o: null, h: null, l: null, c: null, n_open: 0, open_obs: null, close_obs: null, max_stale_s: null });

export function mergeMinute(stored: StoredMinute | null, fresh: MinuteRow): MinuteMerge {
  if (stored && (stored.feed !== fresh.symbol || stored.t !== fresh.t)) throw new Error(`merge of ${fresh.symbol} ${fresh.t} with stored ${stored.feed} ${stored.t}`);
  const rejectedNew = Math.max(0, fresh.n_rejected - (stored?.n_rejected ?? 0));
  const out = (write: StoredMinute | null, event: MergeEvent, evidence: ConflictEvidence[] = []): MinuteMerge => ({
    write,
    event,
    evidence,
    becameConflict: write !== null && write.state === 'conflict',
    rejectedNew,
  });
  const tries = stored?.tries ?? 0;

  if (fresh.state === 'incomplete') {
    if (!stored) return out(toStored(fresh, 1), 'new');
    if (stored.state === 'incomplete') return out({ ...stored, tries: stored.tries + 1, n_rejected: Math.max(stored.n_rejected, fresh.n_rejected) }, 'retry');
    return out(null, 'kept');
  }

  if (fresh.state === 'conflict') {
    const evidence = sameSecond(fresh.symbol, fresh.t, fresh, fresh.conflicts);
    if (stored?.state === 'conflict') return out(null, 'kept', evidence);
    return out(toStored(fresh, tries), 'conflict', evidence);
  }

  if (!isProven(fresh.state)) throw new Error(`fresh row ${fresh.symbol} ${fresh.t} has state ${fresh.state}`);
  if (!stored) return out(toStored(fresh, 0), 'new');
  if (stored.state === 'incomplete') return out(toStored(fresh, tries), 'proved');
  if (stored.state === 'conflict') {
    const more = stored.raw_rule === fresh.raw_rule && stored.raw_fp !== fresh.raw_fp ? [refetch(stored, fresh)] : [];
    return out(null, 'kept', more);
  }
  if (!isProven(stored.state)) throw new Error(`stored row ${stored.feed} ${stored.t} has state ${stored.state}`);

  // Proven over proven.
  if (stored.raw_rule !== fresh.raw_rule) return out(toStored(fresh, tries), 'reinterpreted');
  if (stored.raw_fp !== fresh.raw_fp) return out(poisoned(stored), 'conflict', [refetch(stored, fresh)]);
  if (stored.rules_version !== fresh.rules_version) return out(toStored(fresh, tries), 'reinterpreted');
  if (sameResult(stored, toStored(fresh, tries))) return out(null, 'identical');
  return out(null, 'internal_mismatch');
}
