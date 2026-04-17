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
 *  2. EDITORIAL (NewsAPI augment, top of feed when available):
 *     - /v2/top-headlines?category=sports → real sports headlines
 *     - /v2/top-headlines?category=business + crypto keyword filter
 *     Skipped entirely if NEWS_API_KEY is absent. NewsAPI 5xx / timeout /
 *     rate-limit also falls back silently to derived-only.
 *
 * Cache: 15-min revalidate (NewsAPI free tier = 100 req/day, so ~96/day
 * worst case). Each upstream is in its own try/catch so one failure
 * cannot poison the response.
 */

export const revalidate = 900; // 15 min

type Tag = 'FOOTBALL' | 'CRYPTO' | 'NBA';
type NewsItem = {
  kind: 'headline' | 'event';
  tag: Tag;
  title: string;
  time: string; // "10M AGO" style, precomputed server-side
  url?: string;
};

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

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
    .slice(0, 5)
    .map((e) => {
      const sign = e.change > 0 ? '+' : '';
      return {
        kind: 'event' as const,
        tag: 'CRYPTO' as const,
        title: `${e.label} ${sign}${e.change.toFixed(2)}% past 24h`,
        time: 'NOW',
      };
    });
}

// ---------------------------------------------------------------
// Editorial source (NewsAPI augment, optional)
// ---------------------------------------------------------------

/**
 * One NewsAPI helper, three beat-specific strategies:
 *
 * - Football: `/v2/everything?q="soccer OR football"&domains=<footy outlets>`
 *   — general sports category leaks too much American football / MMA noise,
 *   so we restrict to dedicated soccer/football outlets + query filter.
 * - NBA: `/v2/everything?q=NBA&domains=<nba outlets>&sortBy=publishedAt`
 *   — scopes to NBA-focused publications so we get actual basketball coverage
 *   not tangential sports mentions.
 * - Crypto: `/v2/everything?domains=<crypto outlets>&sortBy=publishedAt`
 *   — crypto-only outlet whitelist; domain gating alone is enough since
 *   everything on CoinDesk/Decrypt/The Block is crypto by definition.
 *
 * All three filter out `[Removed]` titles (NewsAPI's marker for takedowns
 * / DMCA / paywalls).
 */
async function fetchNewsApi(
  beat: 'sports' | 'nba' | 'crypto',
  tag: Tag,
  limit: number,
): Promise<NewsItem[]> {
  if (!NEWS_API_KEY) return [];

  let url: string;
  if (beat === 'crypto') {
    const domains =
      'coindesk.com,decrypt.co,theblock.co,cointelegraph.com,cryptoslate.com,bitcoinmagazine.com';
    url = `https://newsapi.org/v2/everything?domains=${domains}&language=en&sortBy=publishedAt&pageSize=15`;
  } else if (beat === 'nba') {
    const domains = 'espn.com,bleacherreport.com,cbssports.com,theathletic.com,nytimes.com';
    const q = encodeURIComponent('NBA');
    url = `https://newsapi.org/v2/everything?q=${q}&domains=${domains}&language=en&sortBy=publishedAt&pageSize=15`;
  } else {
    // sports = soccer/football editorial
    const domains = 'espn.com,theguardian.com,bbc.co.uk,skysports.com,goal.com';
    const q = encodeURIComponent('soccer OR "football" OR "Premier League" OR "Champions League"');
    url = `https://newsapi.org/v2/everything?q=${q}&domains=${domains}&language=en&sortBy=publishedAt&pageSize=15`;
  }

  const res = await fetch(url, {
    headers: { 'X-Api-Key': NEWS_API_KEY },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    articles?: Array<{ title?: string; url?: string; publishedAt?: string }>;
  };
  return (json.articles ?? [])
    .filter(
      (a) =>
        a.title
        && a.title.trim().length > 0
        && !a.title.toLowerCase().startsWith('[removed]'),
    )
    .slice(0, limit)
    .map((a) => ({
      kind: 'headline' as const,
      tag,
      title: a.title!,
      time: relativeTime(a.publishedAt),
      // Only propagate http(s) URLs. A compromised publisher returning
      // `javascript:...` or `data:text/html,...` would otherwise render as
      // a clickable XSS vector in NewsFeed. Defense-in-depth — NewsFeed
      // also validates client-side.
      url: a.url && /^https?:\/\//i.test(a.url) ? a.url : undefined,
    }));
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
    fetchNewsApi('sports', 'FOOTBALL', 5),
    fetchNewsApi('nba', 'NBA', 5),
    fetchNewsApi('crypto', 'CRYPTO', 5),
  ]);
  const editorialItems: NewsItem[] = [];
  for (const r of editorial) {
    if (r.status === 'fulfilled') editorialItems.push(...r.value);
  }

  // Interleave editorial by tag so the feed doesn't dump all FOOTBALL first,
  // then all NBA, then all CRYPTO — that made the panel look FOOTBALL-heavy
  // on tall viewports. Round-robin produces an even rhythm.
  const byTag = {
    FOOTBALL: editorialItems.filter((i) => i.tag === 'FOOTBALL'),
    NBA: editorialItems.filter((i) => i.tag === 'NBA'),
    CRYPTO: editorialItems.filter((i) => i.tag === 'CRYPTO'),
  };
  const interleaved: NewsItem[] = [];
  for (let i = 0; i < 10; i++) {
    for (const tag of ['FOOTBALL', 'NBA', 'CRYPTO'] as const) {
      const pick = byTag[tag][i];
      if (pick) interleaved.push(pick);
    }
  }

  // Editorial on top when we have it; derived as the always-present baseline.
  // Overall cap is roomy (30) so the xl+ intel panel scrolls through a full
  // news shift rather than looking half-empty on slow days.
  const items = [...interleaved.slice(0, 12), ...derivedItems].slice(0, 30);

  return NextResponse.json({ items });
}
