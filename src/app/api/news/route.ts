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

async function fetchDerivedCrypto(): Promise<NewsItem[]> {
  // Widened to cover the full asset registry. Sort by |change| so the
  // panel leads with the biggest movers, not always the majors.
  const COINS: Array<{ coingeckoId: string; label: string }> = [
    { coingeckoId: 'bitcoin', label: 'BTC' },
    { coingeckoId: 'ethereum', label: 'ETH' },
    { coingeckoId: 'solana', label: 'SOL' },
    { coingeckoId: 'avalanche-2', label: 'AVAX' },
    { coingeckoId: 'near', label: 'NEAR' },
    { coingeckoId: 'aptos', label: 'APT' },
    { coingeckoId: 'sui', label: 'SUI' },
    { coingeckoId: 'dogecoin', label: 'DOGE' },
    { coingeckoId: 'chainlink', label: 'LINK' },
  ];
  const ids = COINS.map((c) => c.coingeckoId).join(',');
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
    { cache: 'no-store' },
  );
  if (!res.ok) return [];
  const json = (await res.json()) as Record<
    string,
    { usd: number; usd_24h_change?: number } | undefined
  >;
  return COINS.map((c) => ({
    label: c.label,
    change: json[c.coingeckoId]?.usd_24h_change ?? 0,
  }))
    .filter((e) => e.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 3)
    .map((e) => {
      const sign = e.change > 0 ? '+' : '';
      return {
        kind: 'event' as const,
        tag: 'CRYPTO' as const,
        title: `${e.label} ${sign}${e.change.toFixed(2)}% past 24h`,
        // Label "24H" not "NOW" — the change is measured over the last
        // 24h, not this moment. Calling it NOW reads as a breaking
        // headline and misleads users.
        time: '24H',
        // Sort timestamp sits ~1h back so genuinely fresh editorial
        // (<1h old) can outrank movers. Otherwise movers always crown
        // the feed on slow news days just because their clock says now.
        publishedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };
    });
}

// ---------------------------------------------------------------
// Editorial sources — ESPN (soccer, NBA) + CoinDesk RSS (crypto)
// ---------------------------------------------------------------

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
      headers: { 'User-Agent': 'Mozilla/5.0 Mako Markets' },
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
    fetchDerivedCrypto(),
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

  // Sort the full merged set by publishedAt desc so the panel leads with
  // whatever is freshest across every source, regardless of tag. Items
  // without a timestamp (shouldn't happen, but safe) sink to the bottom.
  const merged = [...editorialItems, ...derivedItems].sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });

  // Strip the internal sort key before returning; client only consumes
  // the precomputed `time` string.
  const items = merged.slice(0, 30).map(({ publishedAt: _p, ...rest }) => rest);

  return NextResponse.json({ items });
}
