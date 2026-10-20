// ----------------------------------------------------------------------------
// price-recorder/src/fetcher.ts
//
// Fetching every report of a minute, with proof of exhaustion (CHARTS_DS_PLAN 3.4), for the live minute and the live
// catch-up of one tick. All calls go through the tick's Limiter (limiter.ts) and the page client (client.ts).
//
// A chain fetches pages for a run of target minutes of one feed, starting at the oldest one, S = its start:
//   * each page must be non-decreasing in `obs` and its first `obs` must be >= S, judged over the page's entries of
//     this feed (JSON feedID equal, a JSON second); otherwise the chain is broken and every minute it was fetching is
//     `incomplete` (fetchOk = false for the candle builder);
//   * the next page restarts at S = the greatest `obs` of an ANCHORED entry of this feed seen so far (entry.ts: its
//     bytes decode to this feed at that second; inclusive restart, plan 3.4 and the 2026-10-16 capture). Not any
//     entry, so junk bytes with a far JSON second cannot move the restart past reports that were never fetched; not
//     only valid ones, so a full page of real reports that fail the value rules (price, validFrom, lastUpdate) is still
//     progress (adversary, unit c); a page that does not move S is no progress and ends the feed's fetching for this
//     tick (minutes already proven stay proven; the rest are retried by later ticks);
//   * a target minute t joins the chain when the chain has fetched up to it (t <= S); a later target that the chain
//     has not reached when the earlier ones are proven starts a new chain at its own start;
//   * a minute [t, t + 60) is proven only by a fetched valid entry with obs >= t + 60 (the exhaustion witness), which
//     the candle builder checks itself (candle.ts); no other path proves a minute;
//   * a short page (fewer than PAGE_LIMIT entries) that does not prove the chain's minutes ends the feed's work for
//     this tick: Chainlink has nothing newer yet, so later minutes are not asked for (they stay incomplete or missing,
//     and are retried by later ticks);
//   * per feed per tick: at most LIVE_PAGE_CAP pages for the live minute and CATCHUP_PAGE_CAP for catch-up. Hitting a
//     cap without the witness leaves those minutes incomplete.
// An answer that is not a page ends the chain: the request proves nothing, and minutes the chain had not yet proven
// stay incomplete. A per-feed refusal also ends the feed's work for the tick (plan 4.1); the caller discards it all.
// ----------------------------------------------------------------------------

import type { PageClient, PageResult } from './client';
import { PAGE_LIMIT } from './client';
import { anchoredEntry, jsonSecond, rawEntry, validEntry, type PageEntry, type ValidEntry } from './entry';
import type { Feed } from './feeds';
import type { Limiter, Refusal } from './limiter';
import { MINUTE_S } from './rules';

/// Pages fetched for a run of target minutes: the minutes it owns, every entry of every page, and whether every page
/// passed the ordering checks.
export type Chain = { minutes: number[]; entries: PageEntry[]; ok: boolean };

/// Why a feed's work stopped early, if it did: an answer that was not a page (its kind), a page that broke the
/// ordering checks, or the limiter's refusal. Null when it stopped because its minutes were proven, its cap was
/// reached, or Chainlink had nothing newer.
export type Stop = Exclude<PageResult['kind'], 'ok' | 'unsent'> | 'disordered' | Refusal | null;

export type FeedFetch = {
  chains: Chain[];
  pages: number;
  stop: Stop;
  /// Every answer, in order (plan 4.1 judges "every live page answered").
  answers: PageResult[];
};

export type PageCheck = { ordered: boolean; maxValid: number | null; maxAnchored: number | null };

const isObject = (e: unknown): e is PageEntry => e !== null && typeof e === 'object' && !Array.isArray(e);

/// validEntry, decoded once per entry object and feed (a page's entries are checked here and built into candles later).
const decoded = new WeakMap<object, { feed: string; v: ValidEntry | null }>();
export function validOnce(e: PageEntry, feed: Feed): ValidEntry | null {
  const hit = decoded.get(e);
  if (hit && hit.feed === feed.feedId) return hit.v;
  const v = validEntry(e, feed);
  decoded.set(e, { feed: feed.feedId, v });
  return v;
}

/// The greatest anchored obs among `reports`, decoded from the end until one is anchored (on an ordered page that is
/// the greatest).
function lastAnchored(feed: Feed, reports: readonly PageEntry[]): number | null {
  for (let i = reports.length - 1; i >= 0; i--) {
    const e = reports[i];
    if (!isObject(e)) continue;
    const a = anchoredEntry(e, feed);
    if (a !== null) return a.obs;
  }
  return null;
}

/// Plan 3.4 page checks over this feed's entries (JSON fields only), the greatest valid obs on the page (on an
/// ordered page that is the last valid entry, so entries are decoded from the end until one is valid), and the
/// greatest anchored obs, which the restart uses.
export function checkPage(feed: Feed, reports: readonly PageEntry[], start: number): PageCheck {
  let prev: number | null = null;
  for (const e of reports) {
    if (!isObject(e)) continue;
    const r = rawEntry(e, feed);
    if (r === null) continue;
    if (prev === null ? r.obs < start : r.obs < prev) return { ordered: false, maxValid: null, maxAnchored: null };
    prev = r.obs;
  }
  for (let i = reports.length - 1; i >= 0; i--) {
    const e = reports[i];
    if (!isObject(e)) continue;
    const v = validOnce(e, feed);
    // A valid entry is anchored; on an ordered page only the invalid tail after it can hold a greater anchored second.
    if (v !== null) return { ordered: true, maxValid: v.obs, maxAnchored: Math.max(v.obs, lastAnchored(feed, reports.slice(i + 1)) ?? v.obs) };
  }
  return { ordered: true, maxValid: null, maxAnchored: lastAnchored(feed, reports) };
}

/// What the candle builder needs of a chain's entries for minute t: every entry whose JSON second lies in [t, t + 60)
/// (this feed's or not, valid or not), and the first valid entry of this feed at or after t + 60 (one witness is all
/// the builder looks for). buildMinute gives the same row for these as for all the entries (test/fetcher.test.ts), at
/// the cost of decoding one minute instead of the whole chain once per minute.
export function minuteInputs(feed: Feed, t: number, entries: readonly PageEntry[]): PageEntry[] {
  const end = t + MINUTE_S;
  const out: PageEntry[] = [];
  let witness: PageEntry | null = null;
  for (const e of entries) {
    if (!isObject(e)) continue;
    const s = jsonSecond(e.observationsTimestamp);
    if (s === null) continue;
    if (s >= t && s < end) out.push(e);
    else if (witness === null && s >= end) {
      const v = validOnce(e, feed);
      if (v !== null && v.obs >= end) witness = e;
    }
  }
  if (witness) out.push(witness);
  return out;
}

export type FetchContext = { limiter: Limiter; client: PageClient };

/// Fetches pages for `targets` (minute starts, ascending, distinct) of one feed, at most `cap` pages.
export async function fetchMinutes(ctx: FetchContext, feed: Feed, targets: readonly number[], cap: number): Promise<FeedFetch> {
  const out: FeedFetch = { chains: [], pages: 0, stop: null, answers: [] };
  let j = 0;
  while (j < targets.length && out.stop === null && out.pages < cap) {
    const chain: Chain = { minutes: [], entries: [], ok: true };
    out.chains.push(chain);
    let S = targets[j];
    let maxValid = -1;
    let maxAnchored = -1;
    let chainAsked = false;
    for (;;) {
      while (j < targets.length && targets[j] <= S) chain.minutes.push(targets[j++]);
      const last = chain.minutes[chain.minutes.length - 1];
      if (maxValid >= last + MINUTE_S) break; // every minute of this chain has its witness
      if (out.pages >= cap) break;
      const res = await ctx.limiter.run(() => ctx.client(feed.feedId, S));
      if (!res.ran || res.value.kind === 'unsent') {
        if (res.ran) ctx.limiter.notSent(); // halted while signing: granted, never sent
        out.stop = res.ran ? 'halted' : res.refusal;
        // A chain the limiter refused before its first page was never attempted: its minutes are not built (a
        // retried minute keeps its tries; the caller builds the live minute as incomplete anyway).
        if (!chainAsked) out.chains.pop();
        break;
      }
      chainAsked = true;
      out.pages++;
      const page = res.value;
      out.answers.push(page);
      if (page.kind !== 'ok') {
        out.stop = page.kind;
        break;
      }
      chain.entries.push(...page.reports);
      const c = checkPage(feed, page.reports, S);
      if (!c.ordered) {
        chain.ok = false;
        out.stop = 'disordered';
        break;
      }
      if (c.maxValid !== null && c.maxValid > maxValid) maxValid = c.maxValid;
      if (c.maxAnchored !== null && c.maxAnchored > maxAnchored) maxAnchored = c.maxAnchored;
      const next = Math.max(S, maxAnchored);
      while (j < targets.length && targets[j] <= next) chain.minutes.push(targets[j++]);
      if (maxValid >= chain.minutes[chain.minutes.length - 1] + MINUTE_S) {
        S = next;
        continue; // proven; the loop head ends the chain or takes the next target reached
      }
      if (page.reports.length < PAGE_LIMIT || next <= S) {
        // Nothing newer yet (short page), or no progress: stop this feed's work for the tick.
        j = targets.length;
        break;
      }
      S = next;
    }
  }
  return out;
}
