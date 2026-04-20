import { NextResponse } from 'next/server';

/**
 * GET /api/news
 *
 * Real-data replacement for the hardcoded mock block on the home feed.
 * Aggregates from two sources:
 *
 *  1. DERIVED (default-safe path, always attempted):
 *     - football-data.org recent FINISHED matches → "Palmeiras 2-1 Cristal · FT"
 *     - balldontlie.io recent Final games → "Lakers 112, Warriors 108"
 *     - CoinGecko 24h movers → "BTC +2.3% past 24h"
 *     These use keys already in .env.local and nearly always succeed, so
 *     the feed never goes empty.
 *
 *  2. EDITORIAL (free, real-time, no NewsAPI tier delay):
 *     - ESPN public news API for soccer + NBA headlines
 *     - CoinDesk RSS for crypto headlines
 *     NewsAPI was retired here: its free tier delays articles ~24h, so
 *     everything stamped "1D AGO" even on healthy news days. ESPN's
 *     `site.api.espn.com` JSON endpoints and CoinDesk's RSS both serve
 *     current-minute timestamps without a key.
 *
 * Cache: 15-min revalidate. Each upstream is in its own try/catch so one
 * failure cannot poison the response.
 */

export const revalidate = 900; // 15 min

type Tag = 'FOOTBALL' | 'CRYPTO' | 'NBA';
type NewsItem = {
  kind: 'headline' | 'event';
  tag: Tag;
  title: string;
  time: string; // "10M AGO" style, precomputed server-side
  url?: string;
  // Internal sort key — ISO of when the thing happened. Not used by the
  // client, stripped before response. Keeps the final merge deterministic:
  // newest first across all sources regardless of tag.
  publishedAt?: string;
};

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY;

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function relativeTime(fromIso: string | undefined): string {
  if (!fromIso) return 'RECENT';
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return 'RECENT';
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}S AGO`;
  if (sec < 3600) return `${Math.floor(sec / 60)}M AGO`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}H AGO`;
  return `${Math.floor(sec / 86400)}D AGO`;
}

function ymd(daysOffset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return d.toISOString().slice(0, 10);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Plucks the inner text of a single XML tag, handling optional CDATA
// wrapping. RSS fields routinely wrap in CDATA to pass HTML through,
// and feeds like CoinDesk's use it inconsistently across items.
function extractXmlTag(block: string, tag: string): string | undefined {
  const re = new RegExp(
    `<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${tag}>`,
  );
  const m = block.match(re);
  if (!m) return undefined;
  const raw = (m[1] ?? m[2] ?? '').trim();
  return raw.length > 0 ? decodeEntities(raw) : undefined;
}

// ---------------------------------------------------------------
// Derived sources (default-safe path)
// ---------------------------------------------------------------

async function fetchDerivedFootball(): Promise<NewsItem[]> {
  if (!FOOTBALL_DATA_API_KEY) return [];
  // 5-day window so the intel panel stays populated even on slow match days.
  const from = ymd(-5);
  const to = ymd(0);
  const res = await fetch(
    `https://api.football-data.org/v4/matches?status=FINISHED&dateFrom=${from}&dateTo=${to}`,
    { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    matches?: Array<{
      utcDate: string;
      score?: { fullTime?: { home?: number | null; away?: number | null } };
      homeTeam: { shortName?: string; name?: string };
      awayTeam: { shortName?: string; name?: string };
    }>;
  };
  return (json.matches ?? [])
    .filter((m) => m.score?.fullTime?.home != null && m.score.fullTime.away != null)
    .slice()
    .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime())
    .slice(0, 8)
    .map((m) => {
      const home = m.homeTeam.shortName ?? m.homeTeam.name ?? 'Home';
      const away = m.awayTeam.shortName ?? m.awayTeam.name ?? 'Away';
      const hg = m.score!.fullTime!.home!;
      const ag = m.score!.fullTime!.away!;
      return {
        kind: 'event' as const,
        tag: 'FOOTBALL' as const,
        title: `${home} ${hg}-${ag} ${away} · FT`,
        time: relativeTime(m.utcDate),
        publishedAt: m.utcDate,
      };
    });
}

async function fetchDerivedNba(): Promise<NewsItem[]> {
  if (!BALLDONTLIE_API_KEY) return [];
  // 10-day window + 100 per page to survive slow-week gaps (offseason,
  // all-star break, scheduling lulls) and still fill the panel with
  // genuine recent Final games.
  const from = ymd(-10);
  const to = ymd(0);
  const res = await fetch(
    `https://api.balldontlie.io/v1/games?start_date=${from}&end_date=${to}&per_page=100`,
    { headers: { Authorization: BALLDONTLIE_API_KEY, Accept: 'application/json' } },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as {
    data?: Array<{
      date: string;
      datetime?: string;
      status?: string;
      home_team: { full_name: string };
      visitor_team: { full_name: string };
      home_team_score?: number | null;
      visitor_team_score?: number | null;
    }>;
  };
  return (json.data ?? [])
    .filter(
      (g) =>
        (g.status ?? '').toLowerCase().includes('final')
        && g.home_team_score != null
        && g.visitor_team_score != null,
    )
    .slice()
    .sort((a, b) => new Date(b.datetime ?? b.date).getTime() - new Date(a.datetime ?? a.date).getTime())
    .slice(0, 6)
    .map((g) => ({
      kind: 'event' as const,
      tag: 'NBA' as const,
      title: `${g.home_team.full_name} ${g.home_team_score}, ${g.visitor_team.full_name} ${g.visitor_team_score}${g.status?.toLowerCase().includes('ot') ? ` (${g.status})` : ''}`,
      time: relativeTime(g.datetime ?? g.date),
      publishedAt: g.datetime ?? g.date,
    }));
}

// ---------------------------------------------------------------
// Editorial sources — ESPN (soccer, NBA) + CoinDesk RSS (crypto)
// ---------------------------------------------------------------
//
// Note: no derived crypto movers here. Earlier revisions synthesized
// "SUI +6.87% past 24h" items from CoinGecko, but a 24h percent change
// has no single publishedAt and any stamp we invented was dishonest.
// Live crypto prices + 24h change already render in the bottom
// PriceTicker; the news panel stays purely real-headline / real-event.

/**
 * ESPN's `site.api.espn.com` exposes per-sport JSON news feeds with no
 * auth required. Real-time timestamps, stable schema. These are the same
 * endpoints ESPN's own web app consumes.
 *
 * NBA lives at a single path (`basketball/nba/news`). Soccer is nested
 * by league — there is no global soccer/news endpoint anymore, so we
 * fan out across the five feeds that drive the bulk of real coverage
 * (Premier League, Champions League, La Liga, Serie A, Bundesliga) and
 * merge. A dead league just returns 404 and gets skipped.
 */
const ESPN_SOCCER_LEAGUES = [
  'eng.1', // Premier League
  'uefa.champions', // Champions League
  'esp.1', // La Liga
  'ita.1', // Serie A
  'ger.1', // Bundesliga
] as const;

async function fetchEspnEndpoint(
  path: string,
  tag: Tag,
): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${path}/news?limit=15`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      articles?: Array<{
        headline?: string;
        published?: string;
        links?: { web?: { href?: string } };
      }>;
    };
    return (json.articles ?? [])
      .filter((a) => a.headline && a.headline.trim().length > 0)
      .map((a) => {
        const href = a.links?.web?.href;
        return {
          kind: 'headline' as const,
          tag,
          title: a.headline!,
          time: relativeTime(a.published),
          // Only propagate http(s) URLs. Defense-in-depth — NewsFeed
          // validates client-side too.
          url: href && /^https?:\/\//i.test(href) ? href : undefined,
          publishedAt: a.published,
        };
      });
  } catch {
    return [];
  }
}

async function fetchEspnNba(limit: number): Promise<NewsItem[]> {
  const items = await fetchEspnEndpoint('basketball/nba', 'NBA');
  return items
    .slice()
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, limit);
}

async function fetchEspnSoccer(limit: number): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    ESPN_SOCCER_LEAGUES.map((l) => fetchEspnEndpoint(`soccer/${l}`, 'FOOTBALL')),
  );
  const merged: NewsItem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      // Dedup across leagues — big stories (transfer rumors, UCL) often
      // publish on multiple league feeds with the same headline.
      const key = item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged
    .sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, limit);
}

/**
 * CoinDesk's RSS feed. Free, real-time, canonical crypto publication.
 * XML is parsed with a narrow regex pass — we only need title / link /
 * pubDate per item, so adding an XML lib would be overkill.
 */
async function fetchCoinDeskRss(limit: number): Promise<NewsItem[]> {
  try {
    // Canonical URL (no trailing slash). The slashed variant 308s here,
    // which Node fetch follows transparently, but using the canonical
    // path avoids the extra hop and a potential redirect quirk on cold
    // serverless starts.
    const res = await fetch('https://www.coindesk.com/arc/outboundfeeds/rss', {
      // A UA is polite for RSS fetches; some feeds 403 the default Node UA.
      headers: { 'User-Agent': 'Mozilla/5.0 Mako Market' },
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const title = extractXmlTag(block, 'title');
      const link = extractXmlTag(block, 'link');
      const pubDate = extractXmlTag(block, 'pubDate');
      if (!title || !link) continue;

      // new Date() parses RFC 2822 pubDate strings natively.
      const parsed = pubDate ? new Date(pubDate) : undefined;
      const iso = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;

      items.push({
        kind: 'headline',
        tag: 'CRYPTO',
        title,
        time: relativeTime(iso),
        url: /^https?:\/\//i.test(link) ? link : undefined,
        publishedAt: iso,
      });
    }
    return items;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------

export async function GET() {
  const derived = await Promise.allSettled([
    fetchDerivedFootball(),
    fetchDerivedNba(),
  ]);
  const derivedItems: NewsItem[] = [];
  for (const r of derived) {
    if (r.status === 'fulfilled') derivedItems.push(...r.value);
  }

  const editorial = await Promise.allSettled([
    fetchEspnSoccer(6),
    fetchEspnNba(6),
    fetchCoinDeskRss(6),
  ]);
  const editorialItems: NewsItem[] = [];
  for (const r of editorial) {
    if (r.status === 'fulfilled') editorialItems.push(...r.value);
  }

  // Sort the full merged set by publishedAt desc. CoinDesk posts far
  // more frequently than ESPN's soccer/NBA feeds, so a pure recency sort
  // produces a wall of crypto up top. We then interleave with a streak
  // cap so consecutive same-tag items never exceed `maxStreak` while
  // freshness still wins within each rotation.
  const sortedByRecency = [...editorialItems, ...derivedItems].sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  const merged = interleaveCapStreak(sortedByRecency, 2);

  // Strip the internal sort key before returning; client only consumes
  // the precomputed `time` string.
  const items = merged.slice(0, 30).map(({ publishedAt: _p, ...rest }) => rest);

  return NextResponse.json({ items });
}

// Recency-first but prevent one dominant tag from monopolizing the feed.
// At each slot pick the freshest available item across all tags — unless
// the last `maxStreak` slots are already that same tag, in which case
// skip to the next-freshest different tag. If every remaining item is
// the same tag (tail case, one tag has outlived the others), the cap is
// relaxed so the feed still drains. Within each tag, relative recency
// order is preserved.
function interleaveCapStreak(items: NewsItem[], maxStreak: number): NewsItem[] {
  const queues: Record<Tag, NewsItem[]> = { FOOTBALL: [], NBA: [], CRYPTO: [] };
  for (const item of items) queues[item.tag].push(item);

  const out: NewsItem[] = [];
  while (queues.FOOTBALL.length || queues.NBA.length || queues.CRYPTO.length) {
    const candidates = (['FOOTBALL', 'NBA', 'CRYPTO'] as const)
      .filter((t) => queues[t].length > 0)
      .map((t) => ({
        tag: t,
        ts: new Date(queues[t][0].publishedAt ?? 0).getTime(),
      }))
      .sort((a, b) => b.ts - a.ts);

    const allowed = candidates.find((c) => {
      if (out.length < maxStreak) return true;
      return !out.slice(-maxStreak).every((i) => i.tag === c.tag);
    });
    const pick = allowed ?? candidates[0];
    out.push(queues[pick.tag].shift()!);
  }
  return out;
}
