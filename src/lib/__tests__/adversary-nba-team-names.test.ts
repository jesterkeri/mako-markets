// Adversary pass on 3794773 (feat/nba-team-names): NBA games on the create page show balldontlie's team `name`
// ("Celtics"), then `full_name`, then `abbreviation`, as football shows club short names (Joshua 2026-10-17).
// Must stay true: the question fits the contract's 200 bytes and passes the sponsor's create checks for every NBA team
// and every question type, and the settlement reference the resolver reads is unchanged by the names.
//
// Team names: the 30 current NBA franchises' nicknames, which is what balldontlie's `name` field carries (shape and
// sample values "Hawks", "Celtics", "Warriors", full_name "Atlanta Hawks" read from docs.balldontlie.io, Get All Teams,
// 2026-10-17). The route is driven through its real GET with fetch replaced; the key is a sentinel, never a real one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { assertCreateMarketShape } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { makoAbi, MAKO_ADDRESS, MarketType } from '../contract';
import { toBytes32 } from '../oracle';
import { buildPool, type BasketballQuestion } from '../pool-create';
import { parseOracleRef } from '../pool-rules';

const NBA_NAMES = [
  'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons', 'Warriors',
  'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves', 'Pelicans', 'Knicks',
  'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards',
];
const NBA_FULL_NAMES_LONGEST = ['Portland Trail Blazers', 'Minnesota Timberwolves', 'Golden State Warriors'];

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const NOW = 1_800_000_000;
const TIPOFF = new Date((NOW + 2 * 86_400) * 1000).toISOString();
const QUESTIONS: BasketballQuestion[] = ['home_win', 'away_win', 'over', 'under'];

function sponsorShape(question: string, oracleRef: string, bct: bigint, ct: bigint): void {
  const data = encodeFunctionData({
    abi: makoAbi,
    functionName: 'createMarket',
    args: [MarketType.BASKETBALL, toBytes32(oracleRef) as Hex, bct, ct, question, 1_000_000n, true],
  });
  assertCreateMarketShape({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, call: { to: MAKO_ADDRESS, value: 0n, data } });
}

describe('every NBA team name fits the question and passes the sponsor, for every question type', () => {
  // The longest total the reference can carry with an 8-digit game id: "12345678:under:" is 15 bytes, 17 left.
  const longTotal = 99999999999999.5;
  for (const names of [NBA_NAMES, NBA_FULL_NAMES_LONGEST]) {
    for (const home of names) {
      for (const visitor of names) {
        if (home === visitor) continue;
        for (const q of QUESTIONS) {
          it(`${visitor} @ ${home} ${q}`, () => {
            const r = buildPool({ kind: 'basketball', game: { id: 12345678, homeTeam: home, visitorTeam: visitor, tipoffIso: TIPOFF }, question: q, total: longTotal }, NOW);
            if (!r.ok) throw new Error(r.reason);
            expect(new TextEncoder().encode(r.pool.question).length).toBeLessThanOrEqual(200);
            // The reference is the game id only, never a team name, so the resolver's lookup is unchanged.
            expect(r.pool.oracleRef).toBe(`12345678:${q}:${q === 'over' || q === 'under' ? String(longTotal) : '0'}`);
            expect(parseOracleRef({ mType: MarketType.BASKETBALL, oracleRef: toBytes32(r.pool.oracleRef) as Hex })).toMatchObject({ kind: 'basketball', type: q });
            sponsorShape(r.pool.question, r.pool.oracleRef, r.pool.bettingCloseTime, r.pool.closeTime);
          });
        }
      }
    }
  }
});

describe('GET /api/discover/basketball: the label falls back name, full_name, abbreviation', () => {
  beforeEach(() => {
    vi.stubEnv('BALLDONTLIE_API_KEY', 'sentinel-not-a-key');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function labels(home: object, visitor: object) {
    const body = { data: [{ id: 18444001, date: '2026-10-20', datetime: '2026-10-20T23:30:00.000Z', status: '2026-10-20T23:30:00Z', home_team: home, visitor_team: visitor }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const { GET } = await import('@/app/api/discover/basketball/route');
    const res = await GET();
    const json = (await res.json()) as { games: { homeTeam: string; visitorTeam: string }[] };
    return json.games[0];
  }

  it('prefers name', async () => {
    expect(await labels({ id: 2, name: 'Celtics', full_name: 'Boston Celtics', abbreviation: 'BOS' }, { id: 25, name: 'Trail Blazers', full_name: 'Portland Trail Blazers', abbreviation: 'POR' })).toMatchObject({ homeTeam: 'Celtics', visitorTeam: 'Trail Blazers' });
  });
  it('a missing or null name falls back to full_name, then abbreviation', async () => {
    expect(await labels({ full_name: 'Boston Celtics', abbreviation: 'BOS' }, { name: null, full_name: null, abbreviation: 'POR' })).toMatchObject({ homeTeam: 'Boston Celtics', visitorTeam: 'POR' });
  });
});
