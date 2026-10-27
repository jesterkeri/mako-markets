// ----------------------------------------------------------------------------
// price-recorder/src/plan.ts
//
// The affected-bucket rule (CHARTS_DS_PLAN 3.5, steps 1 to 6), pure:
//   1. every 1m row the tick built (live, catch-up, backfill) goes into one map keyed (feed, t); two rows for one key
//      is a caller bug (plan 6 keeps live and backfill disjoint) and throws;
//   2. touched hours TH and touched days TD are derived from that map, never from the wall clock;
//   3. the caller reads ALL stored 1m rows of every hour in TH and ALL stored 1h rows of every day in TD (db.ts);
//   4. each built row is merged with its stored row by the precedence table (merge.ts);
//   5. each hour in TH: its four 15m rows and its 1h row from the merged 60 minutes (stored rows overlaid by this
//      tick's writes; a minute with no row is missing, which is exact only because step 3 read every stored row);
//   6. each day in TD: the recomputed 1h rows overlaid on the stored ones, and the 1d row from all 24.
// The result is everything the tick writes for candles in its one batch (plan 4.2 step 6).
// ----------------------------------------------------------------------------

import type { MinuteRow } from './candle';
import { mergeMinute, type ConflictEvidence, type MinuteMerge, type StoredMinute } from './merge';
import { align, DAY, HOUR, rollupDay, rollupHour, type Bucket } from './rollup';

export type Span = { feed: string; start: number };

export type TickPlan = {
  touchedHours: Span[];
  touchedDays: Span[];
  minutes: StoredMinute[];
  quarters: Bucket[];
  hours: Bucket[];
  days: Bucket[];
  evidence: ConflictEvidence[];
  merges: (MinuteMerge & { feed: string; t: number })[];
  /// Sum of rejectedNew: this tick's contribution to runs.rejected, never counting a retried minute's entries twice.
  rejected: number;
};

const key = (feed: string, t: number) => `${feed}\u0000${t}`;

function spans(rows: readonly { symbol: string; t: number }[], width: number): Span[] {
  const seen = new Map<string, Span>();
  for (const r of rows) {
    const start = align(r.t, width);
    seen.set(key(r.symbol, start), { feed: r.symbol, start });
  }
  return [...seen.values()].sort((a, b) => (a.feed < b.feed ? -1 : a.feed > b.feed ? 1 : a.start - b.start));
}

/// TH and TD of a tick's rows (plan 3.5 step 2).
export const touchedHours = (rows: readonly { symbol: string; t: number }[]): Span[] => spans(rows, HOUR);
export const touchedDays = (rows: readonly { symbol: string; t: number }[]): Span[] => spans(rows, DAY);

/// Identical evidence (every field) is recorded once; the insert also skips evidence already stored (db.ts).
function uniqueEvidence(ev: readonly ConflictEvidence[]): ConflictEvidence[] {
  const seen = new Map<string, ConflictEvidence>();
  for (const e of ev) seen.set(JSON.stringify(e), e);
  return [...seen.values()];
}

/// `horizon`: the second up to which minutes count as elapsed (a minute M has elapsed when M + 60 <= horizon).
export function planTick(built: readonly MinuteRow[], stored1m: readonly StoredMinute[], stored1h: readonly Bucket[], horizon: number): TickPlan {
  const fresh = new Map<string, MinuteRow>();
  for (const r of built) {
    const k = key(r.symbol, r.t);
    if (fresh.has(k)) throw new Error(`two built rows for ${r.symbol} ${r.t}`);
    fresh.set(k, r);
  }
  const rows = [...fresh.values()];
  const TH = touchedHours(rows);
  const TD = touchedDays(rows);
  const inTH = new Set(TH.map((s) => key(s.feed, s.start)));
  const inTD = new Set(TD.map((s) => key(s.feed, s.start)));

  const stored = new Map<string, StoredMinute>();
  for (const m of stored1m) {
    if (!inTH.has(key(m.feed, align(m.t, HOUR)))) throw new Error(`stored 1m row ${m.feed} ${m.t} is outside the touched hours`);
    const k = key(m.feed, m.t);
    if (stored.has(k)) throw new Error(`two stored rows for ${m.feed} ${m.t}`);
    stored.set(k, m);
  }
  const storedHours = new Map<string, Bucket>();
  for (const b of stored1h) {
    if (!inTD.has(key(b.feed, align(b.t, DAY)))) throw new Error(`stored 1h row ${b.feed} ${b.t} is outside the touched days`);
    const k = key(b.feed, b.t);
    if (storedHours.has(k)) throw new Error(`two stored 1h rows for ${b.feed} ${b.t}`);
    storedHours.set(k, b);
  }

  // Step 4: merge, then overlay the writes on the stored rows.
  const merged = new Map(stored);
  const merges: TickPlan['merges'] = [];
  const minutes: StoredMinute[] = [];
  const evidence: ConflictEvidence[] = [];
  let rejected = 0;
  for (const r of rows) {
    const m = mergeMinute(stored.get(key(r.symbol, r.t)) ?? null, r);
    merges.push({ ...m, feed: r.symbol, t: r.t });
    evidence.push(...m.evidence);
    rejected += m.rejectedNew;
    if (m.write) {
      minutes.push(m.write);
      merged.set(key(r.symbol, r.t), m.write);
    }
  }

  // Step 5: every touched hour from its merged minutes.
  const byHour = new Map<string, StoredMinute[]>();
  for (const m of merged.values()) {
    const k = key(m.feed, align(m.t, HOUR));
    const list = byHour.get(k);
    if (list) list.push(m);
    else byHour.set(k, [m]);
  }
  const quarters: Bucket[] = [];
  const hours: Bucket[] = [];
  const hourMap = new Map(storedHours);
  for (const s of TH) {
    const { q, h } = rollupHour(s.feed, s.start, byHour.get(key(s.feed, s.start)) ?? [], horizon);
    quarters.push(...q);
    hours.push(h);
    hourMap.set(key(h.feed, h.t), h);
  }

  // Step 6: every touched day from its 1h rows, stored overlaid by recomputed.
  const byDay = new Map<string, Bucket[]>();
  for (const b of hourMap.values()) {
    const k = key(b.feed, align(b.t, DAY));
    const list = byDay.get(k);
    if (list) list.push(b);
    else byDay.set(k, [b]);
  }
  const days = TD.map((s) => rollupDay(s.feed, s.start, byDay.get(key(s.feed, s.start)) ?? [], horizon));

  return { touchedHours: TH, touchedDays: TD, minutes, quarters, hours, days, evidence: uniqueEvidence(evidence), merges, rejected };
}
