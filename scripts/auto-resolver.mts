#!/usr/bin/env tsx
/**
 * scripts/auto-resolver.mts — structured market auto-resolver for MakoMarkets.
 *
 * Resolves:
 * - CRYPTO markets from CoinGecko spot prices
 * - FOOTBALL markets from football-data.org match results
 *
 * Skips:
 * - markets still open
 * - markets already resolved
 * - ADHOC markets (no machine-readable oracleRef)
 *
 * Usage:
 *   pnpm auto-resolver
 *
 * Optional env:
 *   RESOLVER_ONCE=1          run a single tick and exit
 *   MONAD_RPC_URL=...        override public Monad RPC
 *
 * Required env in .env.local:
 *   ADMIN_PRIVATE_KEY=0x...  resolver wallet (must be owner or resolver)
 *   MAKO_ADDRESS=0x...       deployed contract address
 *
 * Required for football resolution:
 *   FOOTBALL_DATA_API_KEY=...
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

console.log('='.repeat(60));
console.log('  Mako auto-resolver (CRYPTO + FOOTBALL)');
console.log('='.repeat(60));
console.log(`  resolver wallet : ${account.address}`);
console.log(`  contract        : ${MAKO_ADDRESS}`);
console.log(`  rpc             : ${RPC_URL}`);
console.log(`  poll interval   : ${POLL_INTERVAL_MS / 1000}s`);
console.log(`  football api    : ${FOOTBALL_DATA_API_KEY ? 'configured' : 'missing (football skipped)'}`);
console.log(`  ctrl+c to stop`);
console.log('='.repeat(60));
console.log('');

enum MarketType {
  FOOTBALL = 0,
  CRYPTO = 1,
  ADHOC = 2,
}

enum Outcome {
  UNRESOLVED = 0,
  YES = 1,
  NO = 2,
  REFUND = 3,
}

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

type CryptoSymbol = 'BTC' | 'ETH' | 'SOL' | 'MON';
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

type FootballSearchMatch = FootballMatchResult & {
  id: number;
  utcDate?: string;
  homeTeamName: string;
  awayTeamName: string;
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
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,monad&vs_currencies=usd',
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) {
      console.warn(`[resolver] coingecko responded ${res.status}`);
      return {};
    }
    const data = (await res.json()) as Record<string, { usd?: number }>;
    return {
      BTC: data.bitcoin?.usd,
      ETH: data.ethereum?.usd,
      SOL: data.solana?.usd,
      MON: data.monad?.usd,
    };
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
  if (!['BTC', 'ETH', 'SOL', 'MON'].includes(symbolPart)) return null;
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
  cache: Map<string, FootballMatchResult | null>,
): Promise<FootballMatchResult | null> {
  if (!FOOTBALL_DATA_API_KEY) return null;
  if (cache.has(matchId)) return cache.get(matchId) ?? null;

  try {
    const res = await fetch(`https://api.football-data.org/v4/matches/${matchId}`, {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_API_KEY,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[resolver] football match ${matchId}: upstream ${res.status} ${res.statusText}`);
      cache.set(matchId, null);
      return null;
    }

    const data = await res.json();
    const normalized = normalizeFootballResult(data);
    cache.set(matchId, normalized);
    return normalized;
  } catch (error) {
    console.warn(`[resolver] football match ${matchId}: fetch failed: ${(error as Error).message}`);
    cache.set(matchId, null);
    return null;
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

function deriveFootballOutcome(
  parsed: FootballOracleRef,
  result: FootballMatchResult,
): Outcome | null {
  // Resolve only when the match is in a clearly final state.
  if (!['FINISHED', 'AWARDED'].includes(result.status)) return null;

  if (parsed.questionType === 'home_win') {
    return result.winner === 'HOME_TEAM' ? Outcome.YES : Outcome.NO;
  }
  if (parsed.questionType === 'away_win') {
    return result.winner === 'AWAY_TEAM' ? Outcome.YES : Outcome.NO;
  }
  if (parsed.questionType === 'draw') {
    return result.winner === 'DRAW' ? Outcome.YES : Outcome.NO;
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
  const footballCache = new Map<string, FootballMatchResult | null>();
  const footballSearchCache = new Map<string, FootballSearchMatch[]>();
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  let scanned = 0;
  let skipped = 0;
  let resolvedCount = 0;
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

    if (market.mType === MarketType.ADHOC) {
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

      const result = await fetchFootballResult(parsed.matchId, footballCache);
      const resolvedResult =
        result
        ?? (await findFootballResultByQuestionFallback(market, parsed, footballSearchCache));
      if (!resolvedResult) {
        console.warn(`[${ts}] market ${i}: no football result for match ${parsed.matchId} — skip`);
        skipped++;
        continue;
      }

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
    } else {
      skipped++;
      continue;
    }

    const label = outcomeLabel(outcome);
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

  console.log(
    `[${ts}] tick done · scanned ${scanned} · skipped ${skipped} · resolved ${resolvedCount}`,
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
