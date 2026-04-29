/**
 * Mako auto-resolver — Cloudflare Worker port.
 *
 * Replaces the drifty GitHub Actions cron (runs every 1–2 hours under
 * load even with a 5-minute cron spec) with CF's reliable 1-minute cron.
 *
 * Logic is a straight port of scripts/auto-resolver.mts:
 *   - Resolves CRYPTO markets from CoinGecko spot prices
 *   - Resolves FOOTBALL markets from football-data.org
 *   - Resolves BASKETBALL markets from balldontlie NBA feed
 *   - Void-status auto-refund (POSTPONED, CANCELLED, Postponed, Canceled)
 *   - Orphan-refund after 2h if upstream 404s a matchId/gameId
 *   - Distinguishes upstream_error (transient, retry) from not_found (refund eligible)
 *   - Refund-burst canary (logs loud warning if ≥3 refunds in one tick)
 *
 * Secrets (set via `wrangler secret put <NAME>`, never in wrangler.toml):
 *   ADMIN_PRIVATE_KEY       — 0x + 64 hex, the resolver wallet
 *   FOOTBALL_DATA_API_KEY   — optional; football markets skip if absent
 *   BALLDONTLIE_API_KEY     — optional; NBA markets skip if absent
 *
 * Public config (env vars in wrangler.toml [vars]):
 *   MAKO_ADDRESS            — deployed contract
 *   MONAD_RPC_URL           — RPC endpoint
 *
 * IMPORTANT: this file must NEVER console.log a secret. Logging
 * `account.address` (public, derived from the key) is fine. Logging
 * `env.ADMIN_PRIVATE_KEY` or the `env` object itself would leak the
 * key to `wrangler tail`. Don't do that.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  hexToString,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { makoAbi } from './abi';

export interface Env {
  // Secrets — injected from `wrangler secret put`, NEVER log these.
  ADMIN_PRIVATE_KEY: string;
  FOOTBALL_DATA_API_KEY?: string;
  BALLDONTLIE_API_KEY?: string;

  // Public config — safe to log.
  MAKO_ADDRESS: string;
  MONAD_RPC_URL: string;

  // Optional switch for dry-run testing.
  DRY_RUN?: string;
}

const RECEIPT_TIMEOUT_MS = 45_000;

// Upstream statuses that mean "the event will not produce a valid result
// on its originally scheduled date" → auto-refund without waiting for the
// 24h grace period + forceRefund. SUSPENDED (football) is intentionally
// EXCLUDED: it often resumes later. If it stays SUSPENDED past 24h the
// forceRefund backstop catches it.
const FOOTBALL_VOID_STATUSES = new Set(['POSTPONED', 'CANCELLED', 'CANCELED']);

// balldontlie sometimes returns "Postponed", "Canceled", and historically
// has used casing variants. Match on lowercase substring for tolerance.
const BASKETBALL_VOID_SUBSTRINGS = ['postpon', 'cancel'];

// If an event is still not found upstream this many seconds past closeTime,
// treat it as orphaned (bogus matchId, deleted upstream, wrong league tier
// the free API key can't see, etc.) and auto-refund. 2h gives generous
// slack for transient 5xx / network blips while staying far below the
// contract's 24h RESOLUTION_GRACE.
const ORPHAN_REFUND_DELAY_SEC = 2n * 60n * 60n;

// If the resolver wants to refund more than this many markets in a single
// tick, something is very likely wrong upstream — print a loud banner.
const REFUND_BURST_THRESHOLD = 3;

enum MarketType {
  FOOTBALL = 0,
  CRYPTO = 1,
  BASKETBALL = 2,
}

enum Outcome {
  UNRESOLVED = 0,
  YES = 1,
  NO = 2,
  REFUND = 3,
}

// v4 Market struct shape — bettingCloseTime sits between closeTime and
// totalYes; protocolFeeBpsSnapshot + creatorFeeBpsSnapshot follow
// creatorFeeClaimed. Read by named field; positional/tuple destructure
// breaks under the v3→v4 field-order change.
type Market = {
  creator: Address;
  mType: number;
  oracleRef: Hex;
  question: string;
  createdAt: bigint;
  closeTime: bigint;
  bettingCloseTime: bigint;
  totalYes: bigint;
  totalNo: bigint;
  yesBettorCount: number;
  noBettorCount: number;
  outcome: number;
  resolved: boolean;
  creatorFeeClaimed: boolean;
  protocolFeeBpsSnapshot: number;
  creatorFeeBpsSnapshot: number;
};

// MIRROR_CRYPTO_ASSETS — duplicated from src/lib/crypto-assets.ts. If you
// add or remove an asset, update src/lib/crypto-assets.ts, scripts/auto-
// resolver.mts, and this file.
type CryptoSymbol =
  | 'BTC' | 'ETH' | 'SOL' | 'AVAX' | 'NEAR'
  | 'APT' | 'SUI' | 'DOGE' | 'LINK' | 'MON';

const CRYPTO_SYMBOLS: readonly CryptoSymbol[] = [
  'BTC', 'ETH', 'SOL', 'AVAX', 'NEAR', 'APT', 'SUI', 'DOGE', 'LINK', 'MON',
] as const;

const COINGECKO_ID_BY_SYMBOL: Record<CryptoSymbol, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  AVAX: 'avalanche-2',
  NEAR: 'near',
  APT: 'aptos',
  SUI: 'sui',
  DOGE: 'dogecoin',
  LINK: 'chainlink',
  MON: 'monad',
};
type ComparatorOp = 'gt' | 'lt';
type PriceMap = Partial<Record<CryptoSymbol, number>>;

type CryptoOracleRef = {
  symbol: CryptoSymbol;
  op: ComparatorOp;
  strike: number;
};

type FootballQuestionType = 'home_win' | 'away_win' | 'draw' | 'over' | 'under';
type FootballOracleRef = {
  matchId: string;
  questionType: FootballQuestionType;
  param: number;
};

type FootballMatchResult = {
  status: string;
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  homeGoals?: number | null;
  awayGoals?: number | null;
};

// Discriminates "upstream confirmed this match doesn't exist" (404) from
// "upstream is broken right now" (5xx / rate-limit / parse failure).
// Only kind:'not_found' is eligible for orphan refund.
type FootballFetchResult =
  | { kind: 'ok'; result: FootballMatchResult }
  | { kind: 'not_found' }
  | { kind: 'upstream_error' };

type FootballSearchMatch = FootballMatchResult & {
  id: number;
  utcDate?: string;
  homeTeamName: string;
  awayTeamName: string;
};

type BasketballQuestionType = 'home_win' | 'away_win' | 'over' | 'under';
type BasketballOracleRef = {
  gameId: number;
  questionType: BasketballQuestionType;
  param: number;
};

type BasketballGameResult = {
  status: string;
  homeScore: number | null;
  visitorScore: number | null;
};

// One batched NBA fetch per tick populates a gameId → result map. Track
// whether the fetch succeeded so a miss is correctly classified as orphan
// vs upstream error.
type NbaFetchState = {
  attempted: boolean;
  ok: boolean;
};

function decodeOracleRefString(ref: Hex): string | null {
  try {
    const raw = hexToString(ref, { size: 32 });
    const decoded = raw.replace(/\0+$/, '').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function parseCryptoOracleRef(ref: Hex): CryptoOracleRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [symbolPart, opPart, strikePart] = parts;
  if (!CRYPTO_SYMBOLS.includes(symbolPart as CryptoSymbol)) return null;
  if (!['gt', 'lt'].includes(opPart)) return null;
  const strike = Number(strikePart);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    symbol: symbolPart as CryptoSymbol,
    op: opPart as ComparatorOp,
    strike,
  };
}

function parseFootballOracleRef(ref: Hex): FootballOracleRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [matchIdPart, typePart, paramPart] = parts;
  if (!/^\d+$/.test(matchIdPart)) return null;
  if (!['home_win', 'away_win', 'draw', 'over', 'under'].includes(typePart)) return null;
  const param = Number(paramPart);
  if (!Number.isFinite(param) || param < 0) return null;
  return {
    matchId: matchIdPart,
    questionType: typePart as FootballQuestionType,
    param,
  };
}

function parseBasketballOracleRef(ref: Hex): BasketballOracleRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [gameIdPart, typePart, paramPart] = parts;
  if (!/^\d+$/.test(gameIdPart)) return null;
  if (!['home_win', 'away_win', 'over', 'under'].includes(typePart)) return null;
  const param = Number(paramPart);
  if (!Number.isFinite(param) || param < 0) return null;
  return {
    gameId: Number(gameIdPart),
    questionType: typePart as BasketballQuestionType,
    param,
  };
}

function normalizeFootballResult(payload: unknown): FootballMatchResult | null {
  if (!payload || typeof payload !== 'object') return null;

  const maybeWrapped = payload as {
    match?: {
      status?: string;
      score?: {
        winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
        fullTime?: { home?: number | null; away?: number | null };
      };
    };
    status?: string;
    score?: {
      winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
      fullTime?: { home?: number | null; away?: number | null };
    };
  };

  const match = maybeWrapped.match ?? maybeWrapped;
  const status = match.status;
  const score = match.score;

  if (typeof status !== 'string') return null;

  return {
    status,
    winner: score?.winner ?? null,
    homeGoals: score?.fullTime?.home ?? null,
    awayGoals: score?.fullTime?.away ?? null,
  };
}

function formatUtcDate(epochSec: bigint): string {
  return new Date(Number(epochSec) * 1000).toISOString().slice(0, 10);
}

function shiftUtcDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|afc)\b/g, ' ')
    .replace(/\bman city\b/g, 'manchester city')
    .replace(/\bman utd\b/g, 'manchester united')
    .replace(/\bspurs\b/g, 'tottenham')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

function teamNamesLikelyMatch(a: string, b: string): boolean {
  const left = normalizeTeamName(a);
  const right = normalizeTeamName(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;

  const aTokens = left.split(' ');
  const bTokens = right.split(' ');
  const overlap = aTokens.filter((t) => bTokens.includes(t)).length;
  if (overlap >= Math.min(aTokens.length, bTokens.length) && overlap > 0) return true;

  const aFirst = aTokens[0];
  const bFirst = bTokens[0];
  const aLast = aTokens[aTokens.length - 1];
  const bLast = bTokens[bTokens.length - 1];
  return aLast === bLast && (aFirst.startsWith(bFirst) || bFirst.startsWith(aFirst));
}

function parseTeamsFromQuestion(
  question: string,
  questionType: FootballQuestionType,
): { homeTeam: string; awayTeam: string } | null {
  const trimmed = question.trim();

  if (questionType === 'home_win' || questionType === 'away_win') {
    const match = trimmed.match(/^Will\s+(.+?)\s+beat\s+(.+?)\?$/i);
    if (!match) return null;
    if (questionType === 'home_win') {
      return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
    }
    return { homeTeam: match[2].trim(), awayTeam: match[1].trim() };
  }

  if (questionType === 'draw') {
    const match = trimmed.match(/^Will\s+(.+?)\s+vs\s+(.+?)\s+end\s+in\s+a\s+draw\?$/i);
    if (!match) return null;
    return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
  }

  const overUnderMatch = trimmed.match(/^(?:Over|Under)\s+2\.5\s+goals\s+in\s+(.+?)\s+vs\s+(.+?)\?$/i);
  if (!overUnderMatch) return null;
  return { homeTeam: overUnderMatch[1].trim(), awayTeam: overUnderMatch[2].trim() };
}

function outcomeLabel(outcome: Outcome): 'YES' | 'NO' | 'REFUND' {
  return outcome === Outcome.YES
    ? 'YES'
    : outcome === Outcome.NO
      ? 'NO'
      : 'REFUND';
}

function deriveCryptoOutcome(parsed: CryptoOracleRef, currentPrice: number): Outcome {
  if (parsed.op === 'gt') {
    return currentPrice > parsed.strike ? Outcome.YES : Outcome.NO;
  }
  return currentPrice < parsed.strike ? Outcome.YES : Outcome.NO;
}

function deriveBasketballOutcome(
  parsed: BasketballOracleRef,
  result: BasketballGameResult,
): Outcome | null {
  const s = result.status.toLowerCase();

  // Terminal non-played states → auto-refund. Checked BEFORE the "final"
  // gate because these will never become "final".
  if (BASKETBALL_VOID_SUBSTRINGS.some((sub) => s.includes(sub))) {
    return Outcome.REFUND;
  }

  if (!s.includes('final')) return null;
  if (result.homeScore == null || result.visitorScore == null) return null;

  if (parsed.questionType === 'home_win') {
    if (result.homeScore === result.visitorScore) return Outcome.REFUND;
    return result.homeScore > result.visitorScore ? Outcome.YES : Outcome.NO;
  }
  if (parsed.questionType === 'away_win') {
    if (result.homeScore === result.visitorScore) return Outcome.REFUND;
    return result.visitorScore > result.homeScore ? Outcome.YES : Outcome.NO;
  }

  const total = result.homeScore + result.visitorScore;
  if (parsed.questionType === 'over') {
    return total > parsed.param ? Outcome.YES : Outcome.NO;
  }
  return total < parsed.param ? Outcome.YES : Outcome.NO;
}

function deriveFootballOutcome(
  parsed: FootballOracleRef,
  result: FootballMatchResult,
): Outcome | null {
  if (FOOTBALL_VOID_STATUSES.has(result.status)) return Outcome.REFUND;
  if (!['FINISHED', 'AWARDED'].includes(result.status)) return null;

  if (
    parsed.questionType === 'home_win' ||
    parsed.questionType === 'away_win' ||
    parsed.questionType === 'draw'
  ) {
    let winner = result.winner;
    // football-data.org has been observed returning FINISHED with
    // winner=null but populated scores — derive from goals as fallback.
    if (
      winner == null &&
      result.homeGoals != null &&
      result.awayGoals != null
    ) {
      if (result.homeGoals > result.awayGoals) winner = 'HOME_TEAM';
      else if (result.awayGoals > result.homeGoals) winner = 'AWAY_TEAM';
      else winner = 'DRAW';
    }
    if (winner == null) return null;

    if (parsed.questionType === 'home_win') {
      return winner === 'HOME_TEAM' ? Outcome.YES : Outcome.NO;
    }
    if (parsed.questionType === 'away_win') {
      return winner === 'AWAY_TEAM' ? Outcome.YES : Outcome.NO;
    }
    return winner === 'DRAW' ? Outcome.YES : Outcome.NO;
  }

  if (result.homeGoals == null || result.awayGoals == null) return null;
  const totalGoals = result.homeGoals + result.awayGoals;
  if (parsed.questionType === 'over') {
    return totalGoals > parsed.param ? Outcome.YES : Outcome.NO;
  }
  return totalGoals < parsed.param ? Outcome.YES : Outcome.NO;
}

function isInsufficientFundsError(message: string): boolean {
  const s = message.toLowerCase();
  return s.includes('insufficient funds') || s.includes('exceeds balance');
}

function isAlreadyResolvedError(message: string): boolean {
  const s = message.toLowerCase();
  return s.includes('alreadyresolved') || s.includes('already resolved');
}

// viem errors include a huge formatted body (URL, Request body, Raw Call
// Arguments, Contract Call, Docs, Details, Version) ~ 20+ lines. Printing
// that for every transient RPC blip drowns `wrangler tail`. Prefer the
// short one-liner; fall back to the first line of the full message.
function shortErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  if (typeof err.shortMessage === 'string' && err.shortMessage.length > 0) {
    return err.shortMessage;
  }
  if (typeof err.message === 'string') return err.message.split('\n')[0];
  return String(e);
}

// --------------------------------------------------------------------------
// Upstream fetchers
// --------------------------------------------------------------------------

// CoinGecko's free tier returns 403 to requests from CF Worker IPs without
// a recognisable User-Agent. A descriptive UA with a project URL gets us
// through reliably (observed 2026-04-21). If this stops working, the next
// step is switching to a keyed endpoint or an alternative price oracle.
const MAKO_USER_AGENT =
  'mako-auto-resolver/1.0 (+https://github.com/jesterkeri/mako-markets)';

async function fetchPrices(): Promise<PriceMap> {
  try {
    const ids = CRYPTO_SYMBOLS.map((s) => COINGECKO_ID_BY_SYMBOL[s]).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { headers: { Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT } },
    );
    if (!res.ok) {
      console.warn(`[resolver] coingecko responded ${res.status}`);
      return {};
    }
    const data = (await res.json()) as Record<string, { usd?: number } | undefined>;
    const out: PriceMap = {};
    for (const sym of CRYPTO_SYMBOLS) {
      const id = COINGECKO_ID_BY_SYMBOL[sym];
      const p = data[id]?.usd;
      if (typeof p === 'number' && p > 0) out[sym] = p;
    }
    return out;
  } catch (error) {
    console.warn(`[resolver] coingecko fetch failed: ${shortErrorMessage(error)}`);
    return {};
  }
}

async function fetchFootballResult(
  matchId: string,
  cache: Map<string, FootballFetchResult>,
  apiKey: string | undefined,
): Promise<FootballFetchResult> {
  // Missing key is a deployment state, not an upstream truth — treat as
  // transient so we don't orphan-refund when the secret gets dropped.
  if (!apiKey) return { kind: 'upstream_error' };
  const cached = cache.get(matchId);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.football-data.org/v4/matches/${matchId}`, {
      headers: { 'X-Auth-Token': apiKey, Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT },
    });

    // 400 and 404 both mean "this matchId isn't a real match" — cacheable,
    // orphan-eligible. Transient 5xx/429 handled below.
    if (res.status === 400 || res.status === 404) {
      console.log(`[resolver] football match ${matchId}: upstream ${res.status} (orphan eligible)`);
      const r: FootballFetchResult = { kind: 'not_found' };
      cache.set(matchId, r);
      return r;
    }

    if (!res.ok) {
      console.warn(`[resolver] football match ${matchId}: upstream ${res.status} ${res.statusText}`);
      return { kind: 'upstream_error' };
    }

    const data = await res.json();
    const normalized = normalizeFootballResult(data);
    if (normalized == null) {
      console.warn(`[resolver] football match ${matchId}: normalize returned null`);
      return { kind: 'upstream_error' };
    }
    const r: FootballFetchResult = { kind: 'ok', result: normalized };
    cache.set(matchId, r);
    return r;
  } catch (error) {
    console.warn(`[resolver] football match ${matchId}: fetch failed: ${shortErrorMessage(error)}`);
    return { kind: 'upstream_error' };
  }
}

async function fetchFootballMatchesAroundDate(
  centerDate: string,
  cache: Map<string, FootballSearchMatch[]>,
  apiKey: string | undefined,
): Promise<FootballSearchMatch[]> {
  if (!apiKey) return [];

  const dateFrom = shiftUtcDate(centerDate, -7);
  const dateTo = shiftUtcDate(centerDate, 7);
  const cacheKey = `${dateFrom}:${dateTo}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? [];

  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/PL/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`,
      { headers: { 'X-Auth-Token': apiKey, Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT } },
    );
    if (!res.ok) {
      console.warn(
        `[resolver] football finished matches ${dateFrom}..${dateTo}: upstream ${res.status} ${res.statusText}`,
      );
      cache.set(cacheKey, []);
      return [];
    }

    const data = (await res.json()) as {
      matches?: Array<{
        id: number;
        utcDate?: string;
        status?: string;
        homeTeam?: { name?: string; shortName?: string; tla?: string };
        awayTeam?: { name?: string; shortName?: string; tla?: string };
        score?: {
          winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
          fullTime?: { home?: number | null; away?: number | null };
        };
      }>;
    };

    const normalized = (data.matches ?? []).map((match) => ({
      id: match.id,
      utcDate: match.utcDate,
      status: match.status ?? 'UNKNOWN',
      winner: match.score?.winner ?? null,
      homeGoals: match.score?.fullTime?.home ?? null,
      awayGoals: match.score?.fullTime?.away ?? null,
      homeTeamName: match.homeTeam?.shortName ?? match.homeTeam?.name ?? match.homeTeam?.tla ?? 'HOME',
      awayTeamName: match.awayTeam?.shortName ?? match.awayTeam?.name ?? match.awayTeam?.tla ?? 'AWAY',
    }));

    cache.set(cacheKey, normalized);
    return normalized;
  } catch (error) {
    console.warn(
      `[resolver] football finished matches ${dateFrom}..${dateTo}: fetch failed: ${shortErrorMessage(error)}`,
    );
    cache.set(cacheKey, []);
    return [];
  }
}

async function findFootballResultByQuestionFallback(
  market: Market,
  parsed: FootballOracleRef,
  cache: Map<string, FootballSearchMatch[]>,
  apiKey: string | undefined,
): Promise<FootballMatchResult | null> {
  const teams = parseTeamsFromQuestion(market.question, parsed.questionType);
  if (!teams) return null;

  const centerDate = formatUtcDate(market.closeTime);
  const candidates = await fetchFootballMatchesAroundDate(centerDate, cache, apiKey);
  if (candidates.length === 0) return null;

  const matches = candidates.filter(
    (m) =>
      teamNamesLikelyMatch(m.homeTeamName, teams.homeTeam) &&
      teamNamesLikelyMatch(m.awayTeamName, teams.awayTeam),
  );
  if (matches.length === 0) return null;

  const targetMs = Number(market.closeTime) * 1000;
  matches.sort((a, b) => {
    const aMs = a.utcDate ? new Date(a.utcDate).getTime() : Number.MAX_SAFE_INTEGER;
    const bMs = b.utcDate ? new Date(b.utcDate).getTime() : Number.MAX_SAFE_INTEGER;
    return Math.abs(aMs - targetMs) - Math.abs(bMs - targetMs);
  });

  const best = matches[0];
  return {
    status: best.status,
    winner: best.winner,
    homeGoals: best.homeGoals,
    awayGoals: best.awayGoals,
  };
}

async function fetchNbaGameCache(
  cache: Map<number, BasketballGameResult>,
  state: NbaFetchState,
  apiKey: string | undefined,
): Promise<void> {
  if (state.attempted) return;
  state.attempted = true;

  if (!apiKey) {
    state.ok = false;
    return;
  }

  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 2);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  try {
    const url = `https://api.balldontlie.io/v1/games?start_date=${startStr}&end_date=${endStr}&per_page=100`;
    const res = await fetch(url, {
      headers: { Authorization: apiKey, Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[resolver] balldontlie games ${startStr}..${endStr}: upstream ${res.status}`);
      state.ok = false;
      return;
    }
    const data = (await res.json()) as {
      data?: Array<{
        id: number;
        status?: string;
        home_team_score?: number | null;
        visitor_team_score?: number | null;
      }>;
    };
    for (const g of data.data ?? []) {
      cache.set(g.id, {
        status: g.status ?? 'UNKNOWN',
        homeScore: g.home_team_score ?? null,
        visitorScore: g.visitor_team_score ?? null,
      });
    }
    state.ok = true;
  } catch (err) {
    console.warn(`[resolver] balldontlie games fetch failed: ${(err as Error).message}`);
    state.ok = false;
  }
}

// --------------------------------------------------------------------------
// Main tick
// --------------------------------------------------------------------------

function validateEnv(env: Env): {
  adminKey: Hex;
  makoAddress: Address;
  rpcUrl: string;
  footballKey: string | undefined;
  balldontlieKey: string | undefined;
  dryRun: boolean;
} {
  const rawAddr = env.MAKO_ADDRESS;
  if (!rawAddr) throw new Error('MAKO_ADDRESS not set in wrangler.toml [vars]');
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) throw new Error(`MAKO_ADDRESS malformed: ${rawAddr}`);
  if (rawAddr.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error('MAKO_ADDRESS is the zero address — refusing to write to null contract');
  }

  const rawKey = env.ADMIN_PRIVATE_KEY?.trim();
  if (!rawKey) throw new Error('ADMIN_PRIVATE_KEY secret not set (wrangler secret put ADMIN_PRIVATE_KEY)');
  // Accept either "0x<64hex>" or bare "<64hex>" — mirrors scripts/with-bw.mjs
  // so the key in Bitwarden can be stored with or without the 0x prefix and
  // it still works for Workers, Node scripts, and Foundry identically.
  const normalizedKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalizedKey)) {
    // Intentionally does NOT include the malformed key value in the error —
    // if it's truncated or corrupted, echoing it would leak partial key
    // bytes into logs.
    throw new Error('ADMIN_PRIVATE_KEY malformed (expected 0x + 64 hex chars)');
  }

  return {
    adminKey: normalizedKey as Hex,
    makoAddress: rawAddr as Address,
    rpcUrl: env.MONAD_RPC_URL || 'https://testnet-rpc.monad.xyz/',
    footballKey: env.FOOTBALL_DATA_API_KEY || undefined,
    balldontlieKey: env.BALLDONTLIE_API_KEY || undefined,
    dryRun: env.DRY_RUN === '1',
  };
}

export async function runResolver(env: Env): Promise<void> {
  const cfg = validateEnv(env);

  const monadTestnet = {
    id: 10143,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
    rpcUrls: {
      default: { http: [cfg.rpcUrl] },
      public: { http: [cfg.rpcUrl] },
    },
  } as const;

  const account = privateKeyToAccount(cfg.adminKey);
  // batch: true → viem groups JSON-RPC calls into a single HTTP request
  // (array body), drastically reducing the number of HTTP hits we make on
  // Monad testnet's 15 req/sec rate limiter. Without this, scanning 30
  // markets blasts 30 sequential eth_calls and ~17 of them get 429'd.
  const walletClient = createWalletClient({
    account,
    chain: monadTestnet,
    transport: http(cfg.rpcUrl, { batch: true }),
  });
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(cfg.rpcUrl, { batch: true }),
  });

  const ts = new Date().toISOString().slice(11, 19);

  // Banner — logs ONLY the public address, never the private key.
  console.log(
    `[${ts}] tick start · resolver=${account.address} · contract=${cfg.makoAddress}` +
    `${cfg.dryRun ? ' · DRY RUN' : ''}` +
    `${cfg.footballKey ? '' : ' · football:skip(no-key)'}` +
    `${cfg.balldontlieKey ? '' : ' · nba:skip(no-key)'}`,
  );

  // Verify authorization — bail early if this Worker's wallet isn't owner
  // or resolver, rather than spam failed txs every minute.
  try {
    const [owner, resolver] = await Promise.all([
      publicClient.readContract({
        address: cfg.makoAddress,
        abi: makoAbi,
        functionName: 'owner',
      }) as Promise<Address>,
      publicClient.readContract({
        address: cfg.makoAddress,
        abi: makoAbi,
        functionName: 'resolver',
      }) as Promise<Address>,
    ]);

    const authorized =
      account.address.toLowerCase() === owner.toLowerCase() ||
      account.address.toLowerCase() === resolver.toLowerCase();
    if (!authorized) {
      console.error(
        `[${ts}] FATAL: wallet ${account.address} is neither owner (${owner}) nor resolver (${resolver}) — skipping tick`,
      );
      return;
    }
  } catch (error) {
    console.error(`[${ts}] authorization check failed: ${shortErrorMessage(error)}`);
    return;
  }

  let count: bigint;
  try {
    count = (await publicClient.readContract({
      address: cfg.makoAddress,
      abi: makoAbi,
      functionName: 'nextMarketId',
    })) as bigint;
  } catch (error) {
    console.warn(`[${ts}] read nextMarketId failed: ${shortErrorMessage(error)}`);
    return;
  }

  if (count === 0n) {
    console.log(`[${ts}] no markets yet`);
    return;
  }

  const prices = await fetchPrices();
  const footballCache = new Map<string, FootballFetchResult>();
  const footballSearchCache = new Map<string, FootballSearchMatch[]>();
  const nbaGameCache = new Map<number, BasketballGameResult>();
  const nbaFetchState: NbaFetchState = { attempted: false, ok: false };
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  // Pre-fetch markets in small parallel chunks, pausing between each. viem's
  // `batch: true` on the transport does NOT batch JSON-RPC array bodies
  // against Monad's public RPC in practice (verified 2026-04-21: batch:true
  // + Promise.allSettled produced MORE rate-limit failures, not fewer, so
  // each request goes out as its own HTTP hit). Monad testnet enforces
  // ~15 req/sec; sending 5 in parallel every 500ms keeps us at ~10 req/sec
  // worst case, well under the limit, without needing multicall3 or an
  // alternative provider. Tradeoff: ~3s added to tick latency for 30
  // markets, which is fine when cron fires every 60s.
  //
  // Uses allSettled so a single getMarket failure (decoding, ABI drift,
  // transient corruption) doesn't tank the whole tick.
  const countNum = Number(count);
  const READ_CHUNK_SIZE = 5;
  const READ_CHUNK_DELAY_MS = 500;
  const marketResults: PromiseSettledResult<Market>[] = [];
  for (let start = 0; start < countNum; start += READ_CHUNK_SIZE) {
    const end = Math.min(start + READ_CHUNK_SIZE, countNum);
    const chunk = await Promise.allSettled(
      Array.from({ length: end - start }, (_, j) =>
        publicClient.readContract({
          address: cfg.makoAddress,
          abi: makoAbi,
          functionName: 'getMarket',
          args: [BigInt(start + j)],
        }) as Promise<Market>,
      ),
    );
    marketResults.push(...chunk);
    if (end < countNum) {
      await new Promise<void>((r) => setTimeout(r, READ_CHUNK_DELAY_MS));
    }
  }

  let scanned = 0;
  let skipped = 0;
  let resolvedCount = 0;
  let refundCount = 0;
  let walletOutOfFunds = false;

  for (let i = 0n; i < count; i++) {
    if (walletOutOfFunds) {
      console.warn(`[${ts}] wallet out of funds earlier in tick — skipping remaining markets`);
      break;
    }

    scanned++;

    const readResult = marketResults[Number(i)];
    if (readResult.status === 'rejected') {
      console.warn(`[${ts}] market ${i}: getMarket failed: ${shortErrorMessage(readResult.reason)}`);
      continue;
    }
    const market = readResult.value;

    if (market.resolved || market.closeTime > nowSec) {
      skipped++;
      continue;
    }

    let outcome: Outcome | null = null;
    let reason = '';

    if (market.mType === MarketType.CRYPTO) {
      const parsed = parseCryptoOracleRef(market.oracleRef);
      if (!parsed) {
        console.warn(`[${ts}] market ${i}: unparseable crypto oracleRef "${market.oracleRef}" — skip`);
        skipped++;
        continue;
      }
      const currentPrice = prices[parsed.symbol];
      if (currentPrice === undefined) {
        console.warn(`[${ts}] market ${i}: no coingecko price for ${parsed.symbol} — skip`);
        skipped++;
        continue;
      }
      outcome = deriveCryptoOutcome(parsed, currentPrice);
      reason = `${parsed.symbol} ${parsed.op} ${parsed.strike} · live $${currentPrice}`;
    } else if (market.mType === MarketType.FOOTBALL) {
      const parsed = parseFootballOracleRef(market.oracleRef);
      if (!parsed) {
        console.warn(`[${ts}] market ${i}: unparseable football oracleRef "${market.oracleRef}" — skip`);
        skipped++;
        continue;
      }
      if (!cfg.footballKey) {
        console.warn(`[${ts}] market ${i}: football api key missing — skip`);
        skipped++;
        continue;
      }

      const primary = await fetchFootballResult(parsed.matchId, footballCache, cfg.footballKey);
      let resolvedResult: FootballMatchResult | null =
        primary.kind === 'ok' ? primary.result : null;
      if (!resolvedResult) {
        resolvedResult = await findFootballResultByQuestionFallback(
          market,
          parsed,
          footballSearchCache,
          cfg.footballKey,
        );
      }

      if (resolvedResult) {
        outcome = deriveFootballOutcome(parsed, resolvedResult);
        if (outcome == null) {
          console.log(`[${ts}] market ${i}: football match ${parsed.matchId} status ${resolvedResult.status} — pending`);
          skipped++;
          continue;
        }
        if (parsed.questionType === 'home_win') {
          reason = `${parsed.matchId} home_win · status ${resolvedResult.status} · winner ${resolvedResult.winner ?? 'UNKNOWN'}`;
        } else if (parsed.questionType === 'away_win') {
          reason = `${parsed.matchId} away_win · status ${resolvedResult.status} · winner ${resolvedResult.winner ?? 'UNKNOWN'}`;
        } else if (parsed.questionType === 'draw') {
          reason = `${parsed.matchId} draw · status ${resolvedResult.status} · winner ${resolvedResult.winner ?? 'UNKNOWN'}`;
        } else {
          const goals = `${resolvedResult.homeGoals ?? '?'}-${resolvedResult.awayGoals ?? '?'}`;
          reason = `${parsed.matchId} ${parsed.questionType} ${parsed.param} · FT ${goals}`;
        }
      } else if (primary.kind === 'not_found') {
        const pastClose = nowSec - market.closeTime;
        if (pastClose > ORPHAN_REFUND_DELAY_SEC) {
          outcome = Outcome.REFUND;
          reason = `${parsed.matchId} not found upstream · orphan refund (${pastClose}s past close)`;
        } else {
          console.log(`[${ts}] market ${i}: football match ${parsed.matchId} not found upstream — pending (${pastClose}s / ${ORPHAN_REFUND_DELAY_SEC}s orphan grace)`);
          skipped++;
          continue;
        }
      } else {
        console.log(`[${ts}] market ${i}: football match ${parsed.matchId} upstream error — pending (transient, will retry)`);
        skipped++;
        continue;
      }
    } else if (market.mType === MarketType.BASKETBALL) {
      const parsed = parseBasketballOracleRef(market.oracleRef);
      if (!parsed) {
        console.warn(`[${ts}] market ${i}: unparseable basketball oracleRef "${market.oracleRef}" — skip`);
        skipped++;
        continue;
      }
      if (!cfg.balldontlieKey) {
        console.warn(`[${ts}] market ${i}: balldontlie api key missing — skip`);
        skipped++;
        continue;
      }

      await fetchNbaGameCache(nbaGameCache, nbaFetchState, cfg.balldontlieKey);
      const result = nbaGameCache.get(parsed.gameId);
      if (!result) {
        if (!nbaFetchState.ok) {
          console.log(`[${ts}] market ${i}: nba game ${parsed.gameId} upstream error — pending (transient, will retry)`);
          skipped++;
          continue;
        }
        const pastClose = nowSec - market.closeTime;
        if (pastClose > ORPHAN_REFUND_DELAY_SEC) {
          outcome = Outcome.REFUND;
          reason = `nba ${parsed.gameId} not found upstream · orphan refund (${pastClose}s past close)`;
        } else {
          console.log(`[${ts}] market ${i}: no balldontlie result for game ${parsed.gameId} — pending (${pastClose}s / ${ORPHAN_REFUND_DELAY_SEC}s orphan grace)`);
          skipped++;
          continue;
        }
      } else {
        outcome = deriveBasketballOutcome(parsed, result);
        if (outcome == null) {
          console.log(`[${ts}] market ${i}: nba game ${parsed.gameId} status ${result.status} — pending`);
          skipped++;
          continue;
        }
        const scores = `${result.homeScore ?? '?'}-${result.visitorScore ?? '?'}`;
        if (parsed.questionType === 'over' || parsed.questionType === 'under') {
          reason = `nba ${parsed.gameId} ${parsed.questionType} ${parsed.param} · FT ${scores}`;
        } else {
          reason = `nba ${parsed.gameId} ${parsed.questionType} · status ${result.status} · FT ${scores}`;
        }
      }
    } else {
      skipped++;
      continue;
    }

    const label = outcomeLabel(outcome);
    if (outcome === Outcome.REFUND) refundCount++;

    if (cfg.dryRun) {
      console.log(`[${ts}] market ${i}: ${reason} · ${label} · [DRY RUN — not written]`);
      resolvedCount++;
      continue;
    }

    console.log(`[${ts}] market ${i}: ${reason} · ${label}`);

    try {
      const hash = await walletClient.writeContract({
        address: cfg.makoAddress,
        abi: makoAbi,
        functionName: 'resolveMarket',
        args: [i, outcome],
      });
      const receipt = await Promise.race([
        publicClient.waitForTransactionReceipt({ hash }),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`receipt timeout after ${RECEIPT_TIMEOUT_MS}ms`)),
            RECEIPT_TIMEOUT_MS,
          );
        }),
      ]);
      if (receipt.status !== 'success') {
        console.warn(`[${ts}] market ${i}: tx reverted (hash ${hash})`);
        continue;
      }
      console.log(
        `[${ts}] market ${i}: RESOLVED ${label} · block ${receipt.blockNumber} · tx ${hash}`,
      );
      resolvedCount++;
    } catch (error) {
      const message = shortErrorMessage(error);
      if (isAlreadyResolvedError(message)) {
        console.warn(`[${ts}] market ${i}: already resolved elsewhere — continuing`);
        continue;
      }
      if (isInsufficientFundsError(message)) {
        console.warn(`[${ts}] market ${i}: resolver wallet out of MON — stopping tick`);
        walletOutOfFunds = true;
        continue;
      }
      console.warn(`[${ts}] market ${i}: resolveMarket failed: ${message}`);
    }
  }

  // Refund-burst canary: catch systemic bugs before they drain markets.
  if (refundCount >= REFUND_BURST_THRESHOLD) {
    console.warn('!'.repeat(60));
    console.warn(
      `[${ts}] REFUND BURST · ${refundCount} refunds this tick (threshold ${REFUND_BURST_THRESHOLD})`,
    );
    console.warn(`[${ts}] investigate upstream health before the next tick writes more`);
    console.warn('!'.repeat(60));
  }

  const modeTag = cfg.dryRun ? ' [DRY RUN]' : '';
  console.log(
    `[${ts}] tick done${modeTag} · scanned ${scanned} · skipped ${skipped} · resolved ${resolvedCount} · refunds ${refundCount}`,
  );
}

export default {
  // CF cron fires scheduled() at every trigger in wrangler.toml.
  // ctx.waitUntil keeps the Worker alive until runResolver finishes
  // (otherwise the event ends when scheduled() returns synchronously).
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runResolver(env).catch((error) => {
        console.error('[resolver] tick error:', shortErrorMessage(error));
      }),
    );
  },

  // No HTTP triggers — a public /tick endpoint would let anyone drain the
  // resolver wallet by spamming ticks. For local testing use
  // `wrangler dev --test-scheduled` which exposes /__scheduled via wrangler
  // itself (not through this handler). This GET only confirms the Worker
  // is alive; it never calls runResolver.
  async fetch(): Promise<Response> {
    return new Response(
      'mako-auto-resolver · cron-only (no HTTP triggers)\n',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    );
  },
};
