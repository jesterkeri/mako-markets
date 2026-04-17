import { NextResponse } from 'next/server';

/**
 * GET /api/discover/basketball
 *
 * Server-side proxy to balldontlie's `/v1/games` endpoint. Keeps the API key
 * off the client bundle (server-only env).
 *
 * Returns upcoming NBA games in the next 7 days. balldontlie's free tier
 * allows 5 req/min, so we cache server-side for 60s.
 *
 * Shape:
 *   key missing → `{ games: [], error: "<reason>" }`
 *   upstream fails → `{ games: [], error: "<reason>" }`
 *   upstream ok → `{ games: [...normalized] }`
 *
 * balldontlie game IDs are integers — no shortening needed (20 chars fits
 * `"<id>:home_win:0"` in bytes32).
 */
export const dynamic = 'force-dynamic';

type BasketballGame = {
  id: number;
  homeTeam: string;
  visitorTeam: string;
  tipoffIso: string;
  tipoffLabel: string;
};

type DiscoverBasketballResponse = {
  games: BasketballGame[];
  error?: string;
};

type UpstreamTeam = {
  id?: number;
  full_name?: string;
  name?: string;
  abbreviation?: string;
};

type UpstreamGame = {
  id: number;
  date?: string;
  datetime?: string;
  status?: string;
  home_team?: UpstreamTeam;
  visitor_team?: UpstreamTeam;
};

type UpstreamResponse = {
  data?: UpstreamGame[];
};

function formatTipoff(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).toUpperCase() + ' UTC';
  } catch {
    return iso;
  }
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftUtcDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function GET(): Promise<NextResponse<DiscoverBasketballResponse>> {
  const apiKey = process.env.BALLDONTLIE_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      games: [],
      error:
        'BALLDONTLIE_API_KEY missing. Sign up free at app.balldontlie.io and add it to .env.local',
    });
  }

  try {
    const start = todayUtcDate();
    const end = shiftUtcDate(start, 7);
    const url = `https://api.balldontlie.io/v1/games?start_date=${start}&end_date=${end}&per_page=25`;

    const res = await fetch(url, {
      headers: {
        Authorization: apiKey,
        Accept: 'application/json',
      },
      next: { revalidate: 60 },
    });

    if (!res.ok) {
      return NextResponse.json({
        games: [],
        error: `balldontlie responded ${res.status} ${res.statusText}`,
      });
    }

    const data = (await res.json()) as UpstreamResponse;
    const rawGames = data.data ?? [];

    // Upcoming only — filter out anything already Final or in-progress, sort by tipoff.
    const upcoming = rawGames.filter((g) => {
      const status = (g.status ?? '').toLowerCase();
      return !status.includes('final') && !status.includes('qtr') && !status.includes('half');
    });

    upcoming.sort((a, b) => {
      const aMs = a.datetime ? new Date(a.datetime).getTime() : Number.MAX_SAFE_INTEGER;
      const bMs = b.datetime ? new Date(b.datetime).getTime() : Number.MAX_SAFE_INTEGER;
      return aMs - bMs;
    });

    const games: BasketballGame[] = upcoming
      .filter((g) => !!g.home_team && !!g.visitor_team)
      .slice(0, 10)
      .map((g) => {
        const iso = g.datetime ?? `${g.date ?? todayUtcDate()}T00:00:00Z`;
        return {
          id: g.id,
          homeTeam:
            g.home_team?.abbreviation ?? g.home_team?.name ?? g.home_team?.full_name ?? 'HOME',
          visitorTeam:
            g.visitor_team?.abbreviation ?? g.visitor_team?.name ?? g.visitor_team?.full_name ?? 'AWAY',
          tipoffIso: iso,
          tipoffLabel: formatTipoff(iso),
        };
      });

    return NextResponse.json(
      { games },
      {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      },
    );
  } catch (err) {
    console.warn('[api/discover/basketball] upstream fetch failed:', err);
    return NextResponse.json({
      games: [],
      error: (err as Error).message,
    });
  }
}
