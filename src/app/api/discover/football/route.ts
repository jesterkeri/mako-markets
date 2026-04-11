import { NextResponse } from 'next/server';

/**
 * GET /api/discover/football
 *
 * Server-side proxy to football-data.org's public `/v4/competitions/PL/matches`
 * endpoint. Keeps the API key off the client bundle (server-only env).
 *
 * Returns a stable normalized shape regardless of upstream status:
 *   - key missing → `{ fixtures: [], error: "<reason>" }` (not 500)
 *   - upstream fails → `{ fixtures: [], error: "<reason>" }` (not 500)
 *   - upstream ok → `{ fixtures: [...normalized] }`
 *
 * Per Codex handoff, there's no mock fallback — an empty fixtures array is
 * the graceful empty state. The FootballTab UI handles that by disabling
 * submit and surfacing the error string.
 */
export const dynamic = 'force-dynamic';

type FootballFixture = {
  id: number;
  homeTeam: string;
  awayTeam: string;
  kickoffIso: string;
  kickoffLabel: string;
};

type DiscoverFootballResponse = {
  fixtures: FootballFixture[];
  error?: string;
};

type UpstreamTeam = {
  id?: number;
  name?: string;
  shortName?: string;
  tla?: string;
};

type UpstreamMatch = {
  id: number;
  homeTeam?: UpstreamTeam;
  awayTeam?: UpstreamTeam;
  utcDate?: string;
  status?: string;
};

type UpstreamResponse = {
  matches?: UpstreamMatch[];
};

function formatKickoff(iso: string): string {
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

export async function GET(): Promise<NextResponse<DiscoverFootballResponse>> {
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;

  if (!apiKey) {
    return NextResponse.json({
      fixtures: [],
      error:
        'FOOTBALL_DATA_API_KEY missing. Sign up free at football-data.org/client/register and add it to .env.local',
    });
  }

  try {
    const res = await fetch(
      'https://api.football-data.org/v4/competitions/PL/matches?status=SCHEDULED',
      {
        headers: {
          'X-Auth-Token': apiKey,
          Accept: 'application/json',
        },
        // Cache on the server for 60s — fixtures don't change that often.
        next: { revalidate: 60 },
      },
    );

    if (!res.ok) {
      return NextResponse.json({
        fixtures: [],
        error: `football-data.org responded ${res.status} ${res.statusText}`,
      });
    }

    const data = (await res.json()) as UpstreamResponse;
    const matches = data.matches ?? [];

    const fixtures: FootballFixture[] = matches
      .filter((m) => !!m.utcDate && !!m.homeTeam && !!m.awayTeam)
      .slice(0, 10) // cap to first 10 upcoming for UI brevity
      .map((m) => ({
        id: m.id,
        homeTeam:
          m.homeTeam?.shortName ?? m.homeTeam?.name ?? m.homeTeam?.tla ?? 'HOME',
        awayTeam:
          m.awayTeam?.shortName ?? m.awayTeam?.name ?? m.awayTeam?.tla ?? 'AWAY',
        kickoffIso: m.utcDate!,
        kickoffLabel: formatKickoff(m.utcDate!),
      }));

    return NextResponse.json(
      { fixtures },
      {
        headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
      },
    );
  } catch (err) {
    console.warn('[api/discover/football] upstream fetch failed:', err);
    return NextResponse.json({
      fixtures: [],
      error: (err as Error).message,
    });
  }
}
