#!/usr/bin/env tsx
/**
 * scripts/auto-resolver.mts — structured market auto-resolver for MakoMarkets.
 *
 * Resolves:
 * - CRYPTO markets from CoinGecko spot prices
 * - FOOTBALL markets from football-data.org match results
 * - BASKETBALL markets from balldontlie NBA game results
 *
 * Skips:
 * - markets still open
 * - markets already resolved
 *
 * Usage:
 *   pnpm auto-resolver
 *
 * Optional env:
 *   RESOLVER_ONCE=1          run a single tick and exit
 *   DRY_RUN=1                log what WOULD resolve without writing on-chain
 *                            (use for validating new refund logic against live
 *                            upstream data before flipping to live)
 *   MONAD_RPC_URL=...        override public Monad RPC
 *
 * Required env in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...  resolver wallet (must be owner or resolver)
 *   MAKO_ADDRESS=0x...       deployed contract address
 *
 * Required for football resolution:
 *   FOOTBALL_DATA_API_KEY=...
 *
 * Required for basketball resolution:
 *   BALLDONTLIE_API_KEY=...  (free tier: 5 req/min — we do 1 req per tick)
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

import {
  createPublicClient,
  createWalletClient,
  http,
  hexToString,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';

// ABI source of truth: prefer the fresh Foundry compile output if present
// (local dev), otherwise fall back to the vendored copy in this repo (CI).
const __dirname = dirname(fileURLToPath(import.meta.url));
const foundryAbiPath = pathResolve(
  __dirname,
  '../../mako-contracts/out/MakoMarkets.sol/MakoMarkets.json',
);
const vendoredAbiPath = pathResolve(__dirname, './mako-abi.json');
const abiPath = existsSync(foundryAbiPath) ? foundryAbiPath : vendoredAbiPath;
const abiJson = JSON.parse(readFileSync(abiPath, 'utf-8')) as { abi: readonly unknown[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makoAbi = abiJson.abi as any;
if (!Array.isArray(makoAbi) || makoAbi.length === 0) {
  console.error(
    '[resolver] FATAL: ABI not found or empty. Run `forge build` in ../mako-contracts/ first.',
  );
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`[resolver] FATAL: ${msg}`);
  process.exit(1);
}

const RPC_URL = process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz/';
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY ?? '';
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY ?? '';
const POLL_INTERVAL_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 45_000;

const rawAddr = process.env.MAKO_ADDRESS;
if (!rawAddr) fail('MAKO_ADDRESS not set in .env.local');
if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) fail(`MAKO_ADDRESS malformed: ${rawAddr}`);
if (rawAddr.toLowerCase() === '0x0000000000000000000000000000000000000000') {
  fail('MAKO_ADDRESS is the zero address — refusing to write to the null contract');
}
const MAKO_ADDRESS = rawAddr as Address;

const rawKey = process.env.ADMIN_PRIVATE_KEY;
if (!rawKey) fail('ADMIN_PRIVATE_KEY not set in .env.local');
if (!/^0x[a-fA-F0-9]{64}$/.test(rawKey)) {
  fail('ADMIN_PRIVATE_KEY malformed (expected 0x + 64 hex chars)');
}
const ADMIN_PRIVATE_KEY = rawKey as Hex;

const monadTestnet = {
  id: 10143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: [RPC_URL] },
  },
} as const;

const account = privateKeyToAccount(ADMIN_PRIVATE_KEY);
const walletClient = createWalletClient({
  account,
  chain: monadTestnet,
  transport: http(RPC_URL),
});
const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL),
});

// Dry-run mode: compute and log every resolution decision, but skip the
// on-chain writeContract + receipt wait. Lets us validate new refund logic
// (void-status, orphan-event, upstream-error classification) against real
// upstream data before allowing it to write state. No gas, no risk.
const DRY_RUN = process.env.DRY_RUN === '1';

// If the resolver wants to refund more than this many markets in a single
// tick, something is very likely wrong upstream (API schema change, mass
// outage classification bug, etc.). Print a loud banner so the operator
// investigates before the refunds stack up on real users.
const REFUND_BURST_THRESHOLD = 3;

console.log('='.repeat(60));
console.log('  Mako auto-resolver (CRYPTO + FOOTBALL + NBA)');
if (DRY_RUN) {
  console.log('  ** DRY RUN ** — no on-chain writes this session');
}
console.log('='.repeat(60));
console.log(`  resolver wallet : ${account.address}`);
console.log(`  contract        : ${MAKO_ADDRESS}`);
console.log(`  rpc             : ${RPC_URL}`);
console.log(`  poll interval   : ${POLL_INTERVAL_MS / 1000}s`);
console.log(`  football api    : ${FOOTBALL_DATA_API_KEY ? 'configured' : 'missing (football skipped)'}`);
console.log(`  balldontlie api : ${BALLDONTLIE_API_KEY ? 'configured' : 'missing (basketball skipped)'}`);
console.log(`  mode            : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
console.log(`  ctrl+c to stop`);
console.log('='.repeat(60));
console.log('');

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

// Upstream statuses that mean "the event will not produce a valid result
// on its originally scheduled date" → auto-refund without waiting for the
// 24h grace period + forceRefund. Operator-driven refund, not user-driven,
// but triggered by upstream truth rather than human judgment.
//
// SUSPENDED (football) is intentionally EXCLUDED: it often resumes (floodlight
// failure, weather break, crowd trouble) and later goes FINISHED. For those
// we'd rather wait; if it stays SUSPENDED past 24h the forceRefund backstop
// catches it.
const FOOTBALL_VOID_STATUSES = new Set(['POSTPONED', 'CANCELLED', 'CANCELED']);

// balldontlie sometimes returns "Postponed", "Canceled", and historically has
// used slight casing variants. Match on lowercase substring for tolerance,
// mirroring the existing `.includes('final')` pattern for terminal states.
const BASKETBALL_VOID_SUBSTRINGS = ['postpon', 'cancel'];

// If an event is still not found upstream this many seconds past closeTime,
// treat it as orphaned (bogus matchId, deleted upstream, wrong league tier
// the free API key can't see, etc.) and auto-refund. Real match data is
// always posted well within this window. 2h gives generous slack for
// transient 5xx / network blips while staying far below the contract's
// 24h RESOLUTION_GRACE (so the orphan refund always beats forceRefund).
const ORPHAN_REFUND_DELAY_SEC = 2n * 60n * 60n;

type Market = {
  creator: Address;
  mType: number;
  oracleRef: Hex;
  question: string;
  createdAt: bigint;
  closeTime: bigint;
  totalYes: bigint;
  totalNo: bigint;
  yesBettorCount: number;
  noBettorCount: number;
  outcome: number;
  resolved: boolean;
  creatorFeeClaimed: boolean;
};

// MIRROR_CRYPTO_ASSETS — duplicated from src/lib/crypto-assets.ts because
// .mts scripts can't import from src/lib cleanly under tsx. If you add or
// remove an asset, update BOTH files + scripts/seed-crypto.mts.
type CryptoSymbol =
  | 'BTC'
  | 'ETH'
  | 'SOL'
  | 'AVAX'
  | 'NEAR'
  | 'APT'
  | 'SUI'
  | 'DOGE'
  | 'LINK'
  | 'MON';

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

// Discriminates "upstream confirmed this match doesn't exist" (404 → orphan
// eligible) from "upstream is broken right now" (5xx / rate-limit / network /
// parse failure → NEVER refund, retry next tick). The old `null`-on-error
// return conflated these, letting a multi-hour API outage auto-refund legit
// markets after the 2-hour orphan grace. Only kind:'not_found' is eligible
// for orphan refund.
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

// -----------------------------------------------------------------------
// Basketball (balldontlie / NBA)
// -----------------------------------------------------------------------
// oracleRef format: `"<gameId>:<home_win|away_win|over|under>:<param>"`
// `param` is 0 for winner questions, a points total (e.g. "215.5") for O/U.
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


function decodeOracleRefString(ref: Hex): string | null {
  try {
    const raw = hexToString(ref, { size: 32 });
    const decoded = raw.replace(/\0+$/, '').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

async function fetchPrices(): Promise<PriceMap> {
  try {
    const ids = CRYPTO_SYMBOLS.map((s) => COINGECKO_ID_BY_SYMBOL[s]).join(',');
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { headers: { Accept: 'application/json' } },
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
    console.warn(`[resolver] coingecko fetch failed: ${(error as Error).message}`);
    return {};
  }
}

function parseCryptoOracleRef(ref: Hex): CryptoOracleRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;

  const parts = decoded.split(':').map((part) => part.trim());
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

  const parts = decoded.split(':').map((part) => part.trim());
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

async function fetchFootballResult(
  matchId: string,
  cache: Map<string, FootballFetchResult>,
): Promise<FootballFetchResult> {
  // No key configured is a deployment state, not an upstream truth — treat
  // as transient so we don't orphan-refund a batch of markets simply because
  // the key env var got dropped.
  if (!FOOTBALL_DATA_API_KEY) return { kind: 'upstream_error' };
  const cached = cache.get(matchId);
  if (cached) return cached;

  try {
    const res = await fetch(`https://api.football-data.org/v4/matches/${matchId}`, {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_API_KEY,
        Accept: 'application/json',
      },
    });

    // 400 and 404 both mean "this matchId isn't a real match." football-
    // data.org returns 400 for matchIds outside their indexed set and 404
    // for matchIds shaped-correctly-but-missing. Either way, cacheable
    // and orphan-eligible — transient 5xx / 429 are handled below.
    if (res.status === 400 || res.status === 404) {
      console.log(
        `[resolver] football match ${matchId}: upstream ${res.status} (orphan eligible)`,
      );
      const r: FootballFetchResult = { kind: 'not_found' };
      cache.set(matchId, r);
      return r;
    }

    if (!res.ok) {
      // 5xx / 401 / 403 / 429 / anything else — transient. Do NOT cache
      // (so the next tick retries) and do NOT orphan-refund.
      console.warn(`[resolver] football match ${matchId}: upstream ${res.status} ${res.statusText}`);
      return { kind: 'upstream_error' };
    }

    const data = await res.json();
    const normalized = normalizeFootballResult(data);
    if (normalized == null) {
      // Schema mismatch / parse failure. Treat as transient — the normalize
      // bug might be our fault or a temporary API hiccup; either way, we
      // must not silently refund a legit market from a parser regression.
      console.warn(`[resolver] football match ${matchId}: normalize returned null`);
      return { kind: 'upstream_error' };
    }
    const r: FootballFetchResult = { kind: 'ok', result: normalized };
    cache.set(matchId, r);
    return r;
  } catch (error) {
    // Network / DNS / AbortError — all transient.
    console.warn(`[resolver] football match ${matchId}: fetch failed: ${(error as Error).message}`);
    return { kind: 'upstream_error' };
  }
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
  const overlap = aTokens.filter((token) => bTokens.includes(token)).length;
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

async function fetchFootballMatchesAroundDate(
  centerDate: string,
  cache: Map<string, FootballSearchMatch[]>,
): Promise<FootballSearchMatch[]> {
  if (!FOOTBALL_DATA_API_KEY) return [];

  const dateFrom = shiftUtcDate(centerDate, -7);
  const dateTo = shiftUtcDate(centerDate, 7);
  const cacheKey = `${dateFrom}:${dateTo}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? [];

  try {
    const res = await fetch(
      `https://api.football-data.org/v4/competitions/PL/matches?status=FINISHED&dateFrom=${dateFrom}&dateTo=${dateTo}`,
      {
        headers: {
          'X-Auth-Token': FOOTBALL_DATA_API_KEY,
          Accept: 'application/json',
        },
      },
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
      `[resolver] football finished matches ${dateFrom}..${dateTo}: fetch failed: ${(error as Error).message}`,
    );
    cache.set(cacheKey, []);
    return [];
  }
}

// -----------------------------------------------------------------------
// Basketball fetchers
// -----------------------------------------------------------------------
// One batched call per tick populates a gameId → result map covering the
// last 2 days. NBA games finalize within hours of tipoff, so that window
// is enough to catch any just-closed market before its closeTime grace.
// The NBA fetch is batched — one call populates games for a 2-day window.
// We track whether THIS tick's fetch actually succeeded, so that a cache
// miss can be correctly attributed (if fetchOk=true, the gameId really
// isn't in the window → orphan eligible; if fetchOk=false, upstream was
// broken → never refund).
type NbaFetchState = {
  attempted: boolean;
  ok: boolean;
};

async function fetchNbaGameCache(
  cache: Map<number, BasketballGameResult>,
  state: NbaFetchState,
): Promise<void> {
  if (state.attempted) return;
  state.attempted = true;

  if (!BALLDONTLIE_API_KEY) {
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
      headers: { Authorization: BALLDONTLIE_API_KEY, Accept: 'application/json' },
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

async function findFootballResultByQuestionFallback(
  market: Market,
  parsed: FootballOracleRef,
  cache: Map<string, FootballSearchMatch[]>,
): Promise<FootballMatchResult | null> {
  const teams = parseTeamsFromQuestion(market.question, parsed.questionType);
  if (!teams) return null;

  const centerDate = formatUtcDate(market.closeTime);
  const candidates = await fetchFootballMatchesAroundDate(centerDate, cache);
  if (candidates.length === 0) return null;

  const matches = candidates.filter(
    (match) =>
      teamNamesLikelyMatch(match.homeTeamName, teams.homeTeam)
      && teamNamesLikelyMatch(match.awayTeamName, teams.awayTeam),
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
  // gate because these statuses will never become "final" and we'd rather
  // refund fast than wait for the 24h forceRefund grace.
  if (BASKETBALL_VOID_SUBSTRINGS.some((sub) => s.includes(sub))) {
    return Outcome.REFUND;
  }

  // balldontlie status is "Final" or "Final/OT" when a game is over.
  // "Final" alone is enough — "Final/OT" contains "Final" too.
  if (!s.includes('final')) return null;
  if (result.homeScore == null || result.visitorScore == null) return null;

  // NBA games can't tie during regular time + OT plays to a decisive result,
  // but guard explicitly anyway — a bad upstream record shouldn't silently
  // pick one side.
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
  // Terminal non-played states → auto-refund. Checked BEFORE the FINISHED
  // gate so we don't wait 24h for a match everyone already knows won't be
  // played on its original date. SUSPENDED is excluded (often resumes).
  if (FOOTBALL_VOID_STATUSES.has(result.status)) return Outcome.REFUND;

  // Resolve only when the match is in a clearly final state.
  if (!['FINISHED', 'AWARDED'].includes(result.status)) return null;

  // Winner-style markets: home_win, away_win, draw. Prefer the explicit
  // `winner` field, but fall back to deriving from the score when winner
  // is null (football-data.org has been observed to return FINISHED with
  // winner=null while homeGoals/awayGoals are populated — a data glitch).
  // If BOTH winner and scores are missing, stay pending instead of
  // silently resolving all three question types as NO.
  if (
    parsed.questionType === 'home_win' ||
    parsed.questionType === 'away_win' ||
    parsed.questionType === 'draw'
  ) {
    let winner = result.winner;
    if (
      winner == null &&
      result.homeGoals != null &&
      result.awayGoals != null
    ) {
      if (result.homeGoals > result.awayGoals) winner = 'HOME_TEAM';
      else if (result.awayGoals > result.homeGoals) winner = 'AWAY_TEAM';
      else winner = 'DRAW';
    }
    if (winner == null) return null; // unknowable — let operator investigate

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

async function waitForReceiptWithTimeout(hash: Hex) {
  return Promise.race([
    publicClient.waitForTransactionReceipt({ hash }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`receipt timeout after ${RECEIPT_TIMEOUT_MS}ms`)), RECEIPT_TIMEOUT_MS);
    }),
  ]);
}

async function verifyAuthorization(): Promise<void> {
  try {
    const [owner, resolver] = await Promise.all([
      publicClient.readContract({
        address: MAKO_ADDRESS,
        abi: makoAbi,
        functionName: 'owner',
      }) as Promise<Address>,
      publicClient.readContract({
        address: MAKO_ADDRESS,
        abi: makoAbi,
        functionName: 'resolver',
      }) as Promise<Address>,
    ]);

    const isAuthorized =
      account.address.toLowerCase() === owner.toLowerCase()
      || account.address.toLowerCase() === resolver.toLowerCase();

    if (!isAuthorized) {
      fail(`resolver wallet ${account.address} is neither owner (${owner}) nor resolver (${resolver})`);
    }
  } catch (error) {
    fail(`could not verify owner/resolver authorization: ${(error as Error).message}`);
  }
}

async function tick(): Promise<void> {
  const ts = new Date().toISOString().slice(11, 19);

  let count: bigint;
  try {
    count = (await publicClient.readContract({
      address: MAKO_ADDRESS,
      abi: makoAbi,
      functionName: 'nextMarketId',
    })) as bigint;
  } catch (error) {
    console.warn(`[${ts}] read nextMarketId failed: ${(error as Error).message}`);
    return;
  }

  if (count === 0n) {
    console.log(`[${ts}] no markets yet`);
    return;
  }

  const prices = await fetchPrices();
  const footballCache = new Map<string, FootballFetchResult>();
  const footballSearchCache = new Map<string, FootballSearchMatch[]>();
  // Lazy NBA cache — populated only if a pending basketball market is seen
  // this tick. Zero API spend on ticks with none.
  const nbaGameCache = new Map<number, BasketballGameResult>();
  const nbaFetchState: NbaFetchState = { attempted: false, ok: false };
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  let scanned = 0;
  let skipped = 0;
  let resolvedCount = 0;
  let refundCount = 0; // for the burst canary below
  let walletOutOfFunds = false;

  for (let i = 0n; i < count; i++) {
    if (walletOutOfFunds) {
      console.warn(`[${ts}] wallet out of funds earlier in tick — skipping remaining markets`);
      break;
    }

    scanned++;

    let market: Market;
    try {
      market = (await publicClient.readContract({
        address: MAKO_ADDRESS,
        abi: makoAbi,
        functionName: 'getMarket',
        args: [i],
      })) as Market;
    } catch (error) {
      console.warn(`[${ts}] market ${i}: getMarket failed: ${(error as Error).message}`);
      continue;
    }

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

      if (!FOOTBALL_DATA_API_KEY) {
        console.warn(`[${ts}] market ${i}: football api key missing — skip`);
        skipped++;
        continue;
      }

      const primary = await fetchFootballResult(parsed.matchId, footballCache);

      // Try team-name fallback whenever primary didn't yield a match.
      // Important: only the primary can distinguish 404 from upstream error;
      // the fallback just returns null-or-match. So primary.kind drives
      // orphan eligibility.
      let resolvedResult: FootballMatchResult | null =
        primary.kind === 'ok' ? primary.result : null;
      if (!resolvedResult) {
        resolvedResult = await findFootballResultByQuestionFallback(
          market,
          parsed,
          footballSearchCache,
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
        // Upstream CONFIRMED this matchId doesn't exist (404) AND the team-
        // name fallback also struck out. Past orphan grace → refund.
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
        // primary.kind === 'upstream_error' — transient failure (5xx, 429,
        // network). NEVER refund from this branch; retry next tick.
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

      if (!BALLDONTLIE_API_KEY) {
        console.warn(`[${ts}] market ${i}: balldontlie api key missing — skip`);
        skipped++;
        continue;
      }

      await fetchNbaGameCache(nbaGameCache, nbaFetchState);
      const result = nbaGameCache.get(parsed.gameId);
      if (!result) {
        if (!nbaFetchState.ok) {
          // Upstream fetch failed this tick — transient error, NEVER refund.
          // Retry next tick.
          console.log(`[${ts}] market ${i}: nba game ${parsed.gameId} upstream error — pending (transient, will retry)`);
          skipped++;
          continue;
        }
        // Upstream responded OK but gameId wasn't in the 2-day window.
        // Treat as orphaned (bogus gameId / out of window / deleted).
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

    if (DRY_RUN) {
      // Compute everything exactly as live would, but stop short of writing.
      // This path is what you want to watch when tuning the refund logic
      // against real upstream behavior.
      console.log(`[${ts}] market ${i}: ${reason} · ${label} · [DRY RUN — not written]`);
      resolvedCount++;
      continue;
    }

    console.log(`[${ts}] market ${i}: ${reason} · ${label}`);

    try {
      const hash = await walletClient.writeContract({
        address: MAKO_ADDRESS,
        abi: makoAbi,
        functionName: 'resolveMarket',
        args: [i, outcome],
      });
      const receipt = await waitForReceiptWithTimeout(hash);
      if (receipt.status !== 'success') {
        console.warn(`[${ts}] market ${i}: tx reverted (hash ${hash})`);
        continue;
      }
      console.log(
        `[${ts}] market ${i}: RESOLVED ${label} · block ${receipt.blockNumber} · tx ${hash}`,
      );
      resolvedCount++;
    } catch (error) {
      const message = (error as Error).message;
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

  // Refund-burst canary: catch systemic bugs (API schema flip, orphan-grace
  // misfire, key drop misclassification) before they drain a bunch of markets.
  if (refundCount >= REFUND_BURST_THRESHOLD) {
    console.warn('!'.repeat(60));
    console.warn(
      `[${ts}] REFUND BURST · ${refundCount} refunds this tick (threshold ${REFUND_BURST_THRESHOLD})`,
    );
    console.warn(`[${ts}] investigate upstream health before the next tick writes more`);
    console.warn('!'.repeat(60));
  }

  const modeTag = DRY_RUN ? ' [DRY RUN]' : '';
  console.log(
    `[${ts}] tick done${modeTag} · scanned ${scanned} · skipped ${skipped} · resolved ${resolvedCount} · refunds ${refundCount}`,
  );
  console.log('');
}

let tickInFlight = false;

async function runTickSafely(): Promise<void> {
  if (tickInFlight) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] previous tick still running — skip overlap`);
    return;
  }
  tickInFlight = true;
  try {
    await tick();
  } catch (error) {
    console.error('[resolver] tick error:', error);
  } finally {
    tickInFlight = false;
  }
}

await verifyAuthorization();
await runTickSafely();

if (process.env.RESOLVER_ONCE === '1') {
  console.log('[resolver] RESOLVER_ONCE=1 · exiting after first tick');
  process.exit(0);
}

setInterval(() => {
  void runTickSafely();
}, POLL_INTERVAL_MS);
