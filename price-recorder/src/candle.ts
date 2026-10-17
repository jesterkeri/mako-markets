// ----------------------------------------------------------------------------
// price-recorder/src/candle.ts
//
// One-minute candle for minute M = [M, M + 60) (CHARTS_DS_PLAN 3.3), built from every entry fetched for the feed
// (all pages, duplicates included; the inclusive restart fetches the boundary second twice). Pure: no I/O.
//
// Minute state, decided by the FIRST matching row (every minute gets exactly one):
//   1 incomplete  the fetch failed its page checks (plan 3.4), or no exhaustion witness (a valid entry at >= M + 60)
//   2 conflict    two DIFFERENT valid entries at one second inside the minute
//   3 empty       zero candle inputs
//   4 open        at least one fresh-open input (OHLC from fresh-open inputs only)
//   5 stale       at least one stale-open input
//   6 unknown     at least one unknown input
//   7 closed      otherwise: every input (at least one, by row 3) is closed
// Row 2's second half (a minute already proven with a different fingerprint) is the store's precedence rule (3.5),
// decided when the row is written (unit b), not here.
// ----------------------------------------------------------------------------

import { concat, keccak256, numberToHex, type Hex } from 'viem';

import type { Feed } from './feeds';
import { candleInput, exhaustionWitness, rawEntry, validEntry, type PageEntry, type ValidEntry } from './entry';
import { MINUTE_S, RAW_RULE, STALE_EXCLUDE_S } from './rules';
import { RULES_VERSION } from './rules-version';

export type MinuteState = 'open' | 'closed' | 'unknown' | 'stale' | 'empty' | 'incomplete' | 'conflict';
export type InputClass = 'fresh-open' | 'stale-open' | 'closed' | 'unknown';

export type Conflict = { obs: number; keccakA: Hex; keccakB: Hex };

export type MinuteRow = {
  symbol: string;
  t: number;
  state: MinuteState;
  /// Exact decimal strings of the 18-decimal integer price; null unless state is `open`.
  o: string | null;
  h: string | null;
  l: string | null;
  c: string | null;
  /// Distinct seconds with at least one candle input (missing seconds are Chainlink's).
  n_reports: number;
  /// Fresh-open candle inputs.
  n_open: number;
  /// Distinct invalid entries whose JSON second lies in the minute.
  n_rejected: number;
  open_obs: number | null;
  close_obs: number | null;
  /// v8 only: max over market-status-2 inputs of floor((obs * 1e9 - lastUpdate) / 1e9); null for v3 or none.
  max_stale_s: number | null;
  /// keccak256 over the candle inputs, and their count. Null when the minute is incomplete (not proven).
  fp: Hex | null;
  n_valid: number;
  /// keccak256 over every raw entry in the minute (valid or not), and their count. Null when incomplete.
  raw_fp: Hex | null;
  n_raw: number;
  raw_rule: number;
  rules_version: string;
  /// Evidence for state `conflict`: both reports' keccak at each contested second.
  conflicts: Conflict[];
};

const NS = 1_000_000_000n;

/// Floor division for bigint (`/` truncates toward zero). A price stamped a few ms after its own report second is real
/// (seen in the NYSE and AAPL captures), and its age is then -1 s, not 0.
const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return (a % b !== 0n) && ((a < 0n) !== (b < 0n)) ? q - 1n : q;
};

/// Plan 3.3 classes. v3 is always fresh-open. v8: status 2 is fresh-open unless the price is strictly older than
/// STALE_EXCLUDE_S (integer nanoseconds); status 1 closed; status 0, and any status the schema does not define,
/// unknown (a gap, never a price).
export function classify(v: ValidEntry): InputClass {
  const r = v.report;
  if (r.schema === 3) return 'fresh-open';
  if (r.marketStatus === 2) return BigInt(v.obs) * NS - r.lastUpdateTimestamp > BigInt(STALE_EXCLUDE_S) * NS ? 'stale-open' : 'fresh-open';
  if (r.marketStatus === 1) return 'closed';
  return 'unknown';
}

/// keccak256 over (obs as 4 bytes || key) for each item, sorted by (obs, key). The empty set hashes the empty string.
export function fingerprint(items: readonly { obs: number; key: Hex }[]): Hex {
  const sorted = [...items].sort((a, b) => a.obs - b.obs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keccak256(concat(sorted.flatMap((x) => [numberToHex(x.obs, { size: 4 }), x.key])));
}

/// Builds minute M of `feed` from every fetched entry. `fetchOk` is false when the pages broke the plan 3.4 checks
/// (descending, first obs before the start, page cap reached without proof): the minute is then incomplete.
export function buildMinute(feed: Feed, M: number, entries: readonly PageEntry[], fetchOk = true): MinuteRow {
  const end = M + MINUTE_S;
  const base: MinuteRow = {
    symbol: feed.symbol,
    t: M,
    state: 'incomplete',
    o: null,
    h: null,
    l: null,
    c: null,
    n_reports: 0,
    n_open: 0,
    n_rejected: 0,
    open_obs: null,
    close_obs: null,
    max_stale_s: null,
    fp: null,
    n_valid: 0,
    raw_fp: null,
    n_raw: 0,
    raw_rule: RAW_RULE,
    rules_version: RULES_VERSION,
    conflicts: [],
  };

  const valid: ValidEntry[] = [];
  // Raw entries by exact identity (entry.ts rawEntry), each marked valid or not; identical values share validity.
  const raw = new Map<string, { obs: number; key: Hex; valid: boolean }>();
  let witness = false;
  for (const e of entries) {
    const r = rawEntry(e, feed);
    const v = validEntry(e, feed);
    if (r && r.obs >= M && r.obs < end) raw.set(r.id, { obs: r.obs, key: r.key, valid: v !== null });
    if (!v) continue;
    if (exhaustionWitness(v, end)) witness = true;
    if (candleInput(v, M)) valid.push(v);
  }

  // Identical bytes at one second count once; two different valid reports at one second are a conflict.
  const inputs = new Map<string, ValidEntry>();
  const bySecond = new Map<number, Hex[]>();
  for (const v of valid) {
    const id = `${v.obs}:${v.key}`;
    if (inputs.has(id)) continue;
    inputs.set(id, v);
    bySecond.set(v.obs, [...(bySecond.get(v.obs) ?? []), v.key]);
  }
  const uniq = [...inputs.values()].sort((a, b) => a.obs - b.obs);
  const rejected = [...raw.values()].filter((x) => !x.valid).length;

  if (!fetchOk || !witness) return { ...base, state: 'incomplete' };

  const proven = {
    n_reports: bySecond.size,
    n_rejected: rejected,
    fp: fingerprint(uniq),
    n_valid: uniq.length,
    raw_fp: fingerprint([...raw.values()]),
    n_raw: raw.size,
  };

  const conflicts: Conflict[] = [];
  for (const [obs, keys] of bySecond) {
    const sorted = [...keys].sort();
    for (let i = 1; i < sorted.length; i++) conflicts.push({ obs, keccakA: sorted[0], keccakB: sorted[i] });
  }
  if (conflicts.length > 0) return { ...base, ...proven, state: 'conflict', conflicts: conflicts.sort((a, b) => a.obs - b.obs) };
  if (uniq.length === 0) return { ...base, ...proven, state: 'empty' };

  const classes = uniq.map((v) => ({ v, cls: classify(v) }));
  const fresh = classes.filter((x) => x.cls === 'fresh-open').map((x) => x.v);
  let maxStale: number | null = null;
  for (const v of uniq) {
    if (v.report.schema !== 8 || v.report.marketStatus !== 2) continue;
    const s = Number(floorDiv(BigInt(v.obs) * NS - v.report.lastUpdateTimestamp, NS));
    maxStale = maxStale === null ? s : Math.max(maxStale, s);
  }
  const counted = { ...base, ...proven, n_open: fresh.length, max_stale_s: maxStale };

  if (fresh.length > 0) {
    let hi = fresh[0].price;
    let lo = fresh[0].price;
    for (const v of fresh) {
      if (v.price > hi) hi = v.price;
      if (v.price < lo) lo = v.price;
    }
    const first = fresh[0];
    const last = fresh[fresh.length - 1];
    return { ...counted, state: 'open', o: first.price.toString(), h: hi.toString(), l: lo.toString(), c: last.price.toString(), open_obs: first.obs, close_obs: last.obs };
  }
  if (classes.some((x) => x.cls === 'stale-open')) return { ...counted, state: 'stale' };
  if (classes.some((x) => x.cls === 'unknown')) return { ...counted, state: 'unknown' };
  return { ...counted, state: 'closed' };
}
