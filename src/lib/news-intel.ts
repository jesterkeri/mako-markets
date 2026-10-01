// Market intel on Home (2a): which headlines show and how old each one reads. Pure, so the parsing and the age
// label are tested without a network or a clock.
//
// `GET /api/news` is cached for 15 minutes and its `time` ("43M AGO") is computed when the cache fills, so it is up
// to 15 minutes stale by the time anyone reads it. The age is therefore worked out in the browser from
// `publishedAt`; `time` is only the fallback for an item without a usable date.

export type IntelTag = 'FOOTBALL' | 'CRYPTO' | 'NBA';

export type IntelItem = {
  tag: IntelTag;
  title: string;
  /// The server's precomputed age ("43M AGO", or "RECENT" when the source gave no date).
  time: string;
  /// Only ever an http(s) link.
  url?: string;
  /// ISO time the story was published or the game finished.
  publishedAt?: string;
};

const TAGS: ReadonlySet<string> = new Set<IntelTag>(['FOOTBALL', 'CRYPTO', 'NBA']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/// The items of a `GET /api/news` body, in the route's order, dropping any item that is malformed or carries an
/// unknown tag. A body that is not `{ items: [...] }` at all is a failed read (null), not an empty feed.
export function parseNews(body: unknown): IntelItem[] | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const out: IntelItem[] = [];
  for (const raw of body.items) {
    if (!isRecord(raw)) continue;
    const { tag, title, time, url, publishedAt } = raw;
    if (typeof tag !== 'string' || !TAGS.has(tag)) continue;
    if (typeof title !== 'string' || title.trim() === '') continue;
    out.push({
      tag: tag as IntelTag,
      title: title.trim(),
      time: typeof time === 'string' ? time : '',
      url: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined,
      publishedAt: typeof publishedAt === 'string' ? publishedAt : undefined,
    });
  }
  return out;
}

/// The first `n` items. The route already orders the feed newest first (capping any one source at two in a row,
/// so crypto's frequent posts cannot fill the panel), so its first items are the newest it has.
export function latestIntel(items: readonly IntelItem[], n: number): IntelItem[] {
  return items.slice(0, Math.max(0, Math.floor(n)));
}

/// The categories the feed has (Market intel's pills, after ALL), in the design's order.
export const INTEL_TAGS: readonly IntelTag[] = ['CRYPTO', 'FOOTBALL', 'NBA'];

/// Where a story was published, from its own link ("espn.com"), or null for a story without one (the feed's game
/// results and price moves).
export function newsSource(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/// Market intel's sections: the last hour, earlier the same local day, and anything older or undated.
export type NewsGroup = 'last' | 'today' | 'earlier';

export function newsGroup(publishedAt: string | undefined, nowMs: number): NewsGroup {
  const t = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(t) || !Number.isFinite(nowMs) || t - nowMs > FUTURE_SKEW_MS) return 'earlier';
  if (nowMs - t < 3_600_000) return 'last';
  return new Date(t).toDateString() === new Date(nowMs).toDateString() ? 'today' : 'earlier';
}

/// Clocks disagree a little; a date this far ahead of the browser's clock is bad data rather than skew.
const FUTURE_SKEW_MS = 60_000;

/// How old an item is: `long` for desktop ("43M AGO", "JUST NOW"), `short` for the mobile cards ("43M", "Now").
/// Worked out from `publishedAt` against `nowMs`; without a usable date, both are the server's `time`.
export function newsAge(publishedAt: string | undefined, fallback: string, nowMs: number): { short: string; long: string } {
  const t = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  if (!Number.isFinite(t) || !Number.isFinite(nowMs) || t - nowMs > FUTURE_SKEW_MS) return { short: fallback, long: fallback };
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (sec < 60) return { short: 'Now', long: 'JUST NOW' };
  const unit = sec < 3_600 ? `${Math.floor(sec / 60)}M` : sec < 86_400 ? `${Math.floor(sec / 3_600)}H` : `${Math.floor(sec / 86_400)}D`;
  return { short: unit, long: `${unit} AGO` };
}
