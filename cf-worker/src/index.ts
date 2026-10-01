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
 *   - One-sided pools (either side 0) settle as REFUND at close with no
 *     price or result fetched, and unresolved one-sided pools are
 *     forceRefund-ed at closeTime + 24h (src/settlement.ts)
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
import {
  getPythPriceIds,
  normalizePythId,
  PRICE_FEED_BY_SYMBOL,
  PYTH_ID_TO_SYMBOL,
} from './price-feed-assets';
import {
  canSend,
  decideAction,
  deferReason,
  isHeldTwoSided,
  newKeeperTick,
  runNoDataAction,
  sendOnce,
  type KeeperIo,
  type SettlementAction,
} from './settlement';

export interface Env {
  // Secrets — injected from `wrangler secret put`, NEVER log these.
  ADMIN_PRIVATE_KEY: string;
  FOOTBALL_DATA_API_KEY?: string;
  BALLDONTLIE_API_KEY?: string;
  /// Bearer token for /api/cron/aa-fast + /api/cron/aa-slow on the
  /// Vercel side. The same value must be in `vercel env ls production`.
  /// Optional only so the Worker still runs market resolution if the
  /// AA scheduler isn't configured yet — but if MAKO_APP_URL is set
  /// and CRON_SECRET is missing, the AA pings are skipped with a log
  /// (we don't fall back to no-auth, which would let any caller hit
  /// the cron routes).
  CRON_SECRET?: string;

  // Public config — safe to log.
  MAKO_ADDRESS: string;
  MONAD_RPC_URL: string;
  /// Mako Markets Vercel URL. When set, the scheduled handler fires
  /// AA cron routes against this origin. Absent → AA scheduling is
  /// off (Worker falls back to market-resolution-only behaviour).
  MAKO_APP_URL?: string;

  // Optional switch for dry-run testing.
  DRY_RUN?: string;

  /// Refund keeper scope. "1" also force-refunds TWO-sided pools at
  /// closeTime + 24h; anything else keeps the keeper to one-sided pools.
  /// See src/settlement.ts for why two-sided is off by default.
  FORCE_REFUND_TWO_SIDED?: string;
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
  // v4 redeploy widened the enum; #180 wires Pyth price-feed
  // resolution for these three classes. MAKO=6 is admin-resolved
  // and intentionally NOT auto-resolved here.
  FOREX = 3,
  COMMODITIES = 4,
  STOCKS = 5,
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
  /// Per-gameId direct lookups already attempted this tick. The batched
  /// window fetch only covers the last 2 days; markets that stall longer
  /// (key outage, worker downtime) reference games the window can never
  /// see again, so misses fall back to GET /v1/games/<id>.
  byIdAttempted: Set<number>;
  /// gameIds the per-id endpoint answered 404 for — the ONLY evidence
  /// strong enough to orphan-refund. Absence from the 2-day window
  /// proves nothing about an old game, and refunding a game that
  /// actually happened robs the winning side.
  byIdNotFound: Set<number>;
  /// Remaining per-id lookups this tick. balldontlie's free tier allows
  /// 5 req/min; the window fetch spends 1, this budget caps the rest.
  byIdBudget: number;
};

const NBA_BY_ID_BUDGET_PER_TICK = 4;

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

// ── Pyth Hermes (#180): FOREX / COMMODITIES / STOCKS ────────────────
//
// Hermes is free + keyless. One batched fetch per tick over all 33
// pinned price IDs (10 FX + 3 metals + 20 US stocks; oil dropped
// post-probe, see [[mako-pyth-feeds]]) returns a `parsed[]` array
// with integer `price` / `conf` strings and a per-feed `expo`. We
// apply the expo and stash the float result keyed by symbol so the
// per-market resolution branches can do a simple lookup.

const PYTH_HERMES_BASE = 'https://hermes.pyth.network/v2/updates/price/latest';

/// Skip resolution if the Pyth confidence interval relative to the
/// price exceeds this ratio. 50bps (0.5%). For thin-liquidity
/// sessions (US equities off-hours, exotic FX during market close)
/// conf can spike to several percent, which would give a wrong
/// binary outcome. Skip + retry next tick.
const CONFIDENCE_REJECT_RATIO = 0.005;

type PythPriceMap = Map<string, { price: number; conf: number }>;

/// Pyth Hermes response shape (parsed subset).
type PythHermesResponse = {
  parsed?: Array<{
    id: string; // bare hex, no 0x prefix (per Pyth v2 API)
    price?: {
      price: string;
      conf: string;
      expo: number;
      publish_time?: number;
    };
  }>;
};

async function fetchPythPrices(): Promise<PythPriceMap> {
  const out: PythPriceMap = new Map();
  try {
    const ids = getPythPriceIds();
    if (ids.length === 0) return out;
    // Hermes wants repeated `ids[]=<id>` params; .join(',') would
    // return the wrong response shape (an empty parsed[]). Build
    // the query string explicitly.
    const qs = ids.map((id) => `ids%5B%5D=${id}`).join('&');
    const res = await fetch(`${PYTH_HERMES_BASE}?${qs}`, {
      headers: { Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[resolver] pyth hermes responded ${res.status}`);
      return out;
    }
    const data = (await res.json()) as PythHermesResponse;
    for (const row of data.parsed ?? []) {
      if (!row || typeof row.id !== 'string' || !row.price) continue;
      // Hermes returns bare hex; canonicalize to `0x...` for the
      // reverse-map lookup. normalizePythId asserts shape too.
      let canonical: `0x${string}`;
      try {
        canonical = normalizePythId(row.id);
      } catch {
        console.warn(`[resolver] pyth: malformed id ${row.id.slice(0, 12)}...`);
        continue;
      }
      const symbol = PYTH_ID_TO_SYMBOL.get(canonical);
      if (!symbol) {
        console.warn(`[resolver] pyth: unmapped id ${canonical.slice(0, 12)}...`);
        continue;
      }
      const priceStr = row.price.price;
      const confStr = row.price.conf;
      const expo = row.price.expo;
      if (typeof priceStr !== 'string' || typeof confStr !== 'string' || typeof expo !== 'number') {
        continue;
      }
      // Pyth price = priceInt * 10^expo. expo is typically -8 for
      // FX/equity, -8 for metals; always negative for these feeds.
      // Number() handles the int strings fine — they fit in a JS
      // float without precision loss at these magnitudes.
      const scale = Math.pow(10, expo);
      const price = Number(priceStr) * scale;
      const conf = Number(confStr) * scale;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(conf) || conf < 0) {
        continue;
      }
      out.set(symbol, { price, conf });
    }
    return out;
  } catch (error) {
    console.warn(`[resolver] pyth fetch failed: ${shortErrorMessage(error)}`);
    return out;
  }
}

/// Parse a bytes32 oracleRef as `SYMBOL:gt|lt:STRIKE` for FOREX /
/// COMMODITIES / STOCKS markets. Mirrors the sponsor-time validator
/// in src/lib/aa-call-allowlist.ts (kept in sync via the price-feed-
/// assets allowlist). Returns null on any failure mode (format,
/// unknown symbol, class mismatch) — resolver logs the skip reason
/// from the calling site.
type PriceFeedOracleRef = {
  symbol: string;
  op: ComparatorOp;
  strike: number;
  class: 'forex' | 'commodities' | 'stocks';
};

function parsePriceFeedOracleRef(
  ref: Hex,
  expectedClass: 'forex' | 'commodities' | 'stocks',
): PriceFeedOracleRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [symbolPart, opPart, strikePart] = parts;
  if (opPart !== 'gt' && opPart !== 'lt') return null;
  if (!/^\+?(\d+\.\d+|\d+|\.\d+)$/.test(strikePart)) return null;
  const strike = Number(strikePart);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const asset = PRICE_FEED_BY_SYMBOL.get(symbolPart);
  if (!asset) return null;
  if (asset.class !== expectedClass) return null;
  return { symbol: symbolPart, op: opPart, strike, class: asset.class };
}

function derivePriceFeedOutcome(
  parsed: PriceFeedOracleRef,
  livePrice: number,
): Outcome {
  if (parsed.op === 'gt') {
    return livePrice > parsed.strike ? Outcome.YES : Outcome.NO;
  }
  return livePrice < parsed.strike ? Outcome.YES : Outcome.NO;
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

/// Budgeted per-game fallback for gameIds outside the 2-day window
/// fetch. A 404 is recorded as definitive not-found (orphan-refund
/// eligible); every other failure is treated as transient so a stale
/// market keeps waiting instead of being wrongly refunded.
async function fetchNbaGameById(
  cache: Map<number, BasketballGameResult>,
  state: NbaFetchState,
  apiKey: string,
  gameId: number,
): Promise<void> {
  if (cache.has(gameId) || state.byIdAttempted.has(gameId)) return;
  if (state.byIdBudget <= 0) return;
  state.byIdAttempted.add(gameId);
  state.byIdBudget--;
  try {
    const res = await fetch(`https://api.balldontlie.io/v1/games/${gameId}`, {
      headers: { Authorization: apiKey, Accept: 'application/json', 'User-Agent': MAKO_USER_AGENT },
    });
    if (res.status === 404) {
      state.byIdNotFound.add(gameId);
      return;
    }
    if (res.status === 429) {
      // Free tier is 5 req/min — stop spending lookups this tick; the
      // next tick gets a fresh budget.
      state.byIdBudget = 0;
      console.warn(`[resolver] balldontlie game ${gameId}: rate limited — pausing by-id lookups this tick`);
      return;
    }
    if (!res.ok) {
      console.warn(`[resolver] balldontlie game ${gameId}: upstream ${res.status}`);
      return;
    }
    const data = (await res.json()) as {
      data?: {
        id: number;
        status?: string;
        home_team_score?: number | null;
        visitor_team_score?: number | null;
      };
    };
    const g = data.data;
    if (!g || typeof g.id !== 'number') return;
    cache.set(g.id, {
      status: g.status ?? 'UNKNOWN',
      homeScore: g.home_team_score ?? null,
      visitorScore: g.visitor_team_score ?? null,
    });
  } catch (err) {
    console.warn(`[resolver] balldontlie game ${gameId} fetch failed: ${(err as Error).message}`);
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
  forceRefundTwoSided: boolean;
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
    forceRefundTwoSided: env.FORCE_REFUND_TWO_SIDED === '1',
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
    `${cfg.balldontlieKey ? '' : ' · nba:skip(no-key)'}` +
    `${cfg.forceRefundTwoSided ? ' · force-refund-two-sided:on' : ''}`,
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

  const footballCache = new Map<string, FootballFetchResult>();
  const footballSearchCache = new Map<string, FootballSearchMatch[]>();
  const nbaGameCache = new Map<number, BasketballGameResult>();
  const nbaFetchState: NbaFetchState = {
    attempted: false,
    ok: false,
    byIdAttempted: new Set(),
    byIdNotFound: new Set(),
    byIdBudget: NBA_BY_ID_BUDGET_PER_TICK,
  };
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

  // Decide every market up front (src/settlement.ts). One-sided pools and
  // pools past closeTime + 24h settle without any price or result, so a
  // provider is only called when some market actually needs its data.
  const decideOpts = { forceRefundTwoSided: cfg.forceRefundTwoSided };
  const actions: (SettlementAction | null)[] = marketResults.map((r) =>
    r.status === 'fulfilled' ? decideAction(r.value, nowSec, decideOpts) : null,
  );
  const needsData = (types: readonly MarketType[]): boolean =>
    marketResults.some(
      (r, idx) =>
        actions[idx] === 'fetch_and_resolve' &&
        r.status === 'fulfilled' &&
        types.includes(r.value.mType),
    );
  const needsCoinGecko = needsData([MarketType.CRYPTO]);
  const needsPyth = needsData([MarketType.FOREX, MarketType.COMMODITIES, MarketType.STOCKS]);

  // No-data settlement (one-sided REFUND + 24h forceRefund keeper). Sends
  // from the same wallet, re-reads each market at the finalized block right
  // before sending, and at most once per market per tick.
  const keeperTick = newKeeperTick(ts, cfg.dryRun, decideOpts);
  const keeperIo: KeeperIo = {
    readFinalized: async (id) => {
      const block = await publicClient.getBlock({ blockTag: 'finalized' });
      const market = (await publicClient.readContract({
        address: cfg.makoAddress,
        abi: makoAbi,
        functionName: 'getMarket',
        args: [id],
        blockNumber: block.number,
      })) as Market;
      return { market, blockNumber: block.number, blockTimestamp: block.timestamp };
    },
    nonceAt: (block) =>
      block === 'latest'
        ? publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' })
        : publicClient.getTransactionCount({ address: account.address, blockNumber: block }),
    send: (tx, nonce) =>
      walletClient.writeContract({
        address: cfg.makoAddress,
        abi: makoAbi,
        functionName: tx.functionName,
        args: tx.args,
        nonce,
      }),
    waitForReceipt: async (hash) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), RECEIPT_TIMEOUT_MS);
      });
      try {
        const r = await Promise.race([publicClient.waitForTransactionReceipt({ hash }), timeout]);
        return r === 'timeout' ? 'timeout' : { status: r.status, blockNumber: r.blockNumber };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    },
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  };

  let scanned = 0;
  let skipped = 0;
  let resolvedCount = 0;
  let refundCount = 0;
  let walletOutOfFunds = false;
  let oneSidedRefunds = 0;
  let forceRefunds = 0;
  let noDataDeferred = 0;
  let heldTwoSided = 0;
  let deferredPrice = 0;

  // No-data actions first, before any price is fetched: each send waits up to RECEIPT_TIMEOUT_MS for its receipt,
  // and a price fetched before them would be minutes old by the time a two-sided pool used it.
  for (let i = 0n; i < count && !walletOutOfFunds; i++) {
    const readResult = marketResults[Number(i)];
    const action = actions[Number(i)];
    if (readResult.status !== 'fulfilled') continue;
    if (action !== 'resolve_one_sided' && action !== 'force_refund') continue;
    const result = await runNoDataAction(keeperIo, keeperTick, i, action);
    if (result === 'sent' || result === 'dry_run') {
      if (action === 'force_refund') forceRefunds++;
      else oneSidedRefunds++;
    } else {
      if (result === 'deferred') noDataDeferred++;
      if (result === 'out_of_funds') walletOutOfFunds = true;
    }
  }

  // CoinGecko (CRYPTO) + Pyth Hermes (FOREX/COMMODITIES/STOCKS) are
  // independent providers; fetch in parallel so a 1s Hermes call
  // doesn't add to tick latency.
  // The tick's one broadcast may already be spent by the no-data pass, the wallet may be out of MON, or a resolver
  // transaction may be landed but not final: then no price pool can be sent this tick either, so no provider is
  // called.
  const canStillSend = canSend(keeperTick.gate) && !walletOutOfFunds;
  const [prices, pythPrices] = await Promise.all([
    needsCoinGecko && canStillSend ? fetchPrices() : Promise.resolve<PriceMap>({}),
    needsPyth && canStillSend ? fetchPythPrices() : Promise.resolve<PythPriceMap>(new Map()),
  ]);
  // Banner-shape skip log mirroring `football:skip(no-key)` / `nba:skip(no-key)`
  // at tick start. Pyth has no API key, so the only condition that warrants
  // a tick-level flag is an empty map from a failed Hermes fetch. Per-market
  // misses still log individually under the resolve loop.
  if (needsPyth && canStillSend && pythPrices.size === 0) {
    console.warn(`[${ts}] pyth:skip(no-symbols) — hermes fetch returned empty`);
  }


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
    const action = actions[Number(i)];

    if (isHeldTwoSided(market, nowSec, decideOpts)) heldTwoSided++;

    // Handled in the no-data pass above.
    if (action === 'resolve_one_sided' || action === 'force_refund') {
      continue;
    }

    // 'skip': resolved, not closed yet, or a MAKO pool (hand-resolved).
    if (action !== 'fetch_and_resolve') {
      skipped++;
      continue;
    }

    // Nothing more can be sent this tick: defer before any price or result is fetched for this pool.
    if (!cfg.dryRun && !canSend(keeperTick.gate)) {
      console.log(`[${ts}] market ${i}: resolveMarket deferred to the next tick (${deferReason(keeperTick.gate)})`);
      deferredPrice++;
      continue;
    }

    // action === 'fetch_and_resolve': a two-sided pool, resolved from its
    // price or result exactly as before.
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
      // The window fetch only sees the last 2 days; a market that
      // stalled longer (key outage, worker downtime) references a game
      // the window can never see again. Fall back to a budgeted
      // per-game lookup so stale games RESOLVE with real scores.
      if (!nbaGameCache.has(parsed.gameId)) {
        await fetchNbaGameById(nbaGameCache, nbaFetchState, cfg.balldontlieKey, parsed.gameId);
      }
      const result = nbaGameCache.get(parsed.gameId);
      if (!result) {
        // Orphan-refund requires DEFINITIVE evidence: a 404 from the
        // per-game endpoint. Window absence or transient upstream
        // errors keep the market pending — never refund a game that
        // may simply not have been fetched yet.
        if (nbaFetchState.byIdNotFound.has(parsed.gameId)) {
          const pastClose = nowSec - market.closeTime;
          if (pastClose > ORPHAN_REFUND_DELAY_SEC) {
            outcome = Outcome.REFUND;
            reason = `nba ${parsed.gameId} 404 upstream · orphan refund (${pastClose}s past close)`;
          } else {
            console.log(`[${ts}] market ${i}: nba game ${parsed.gameId} 404 upstream — pending (${pastClose}s / ${ORPHAN_REFUND_DELAY_SEC}s orphan grace)`);
            skipped++;
            continue;
          }
        } else {
          console.log(`[${ts}] market ${i}: no balldontlie result for game ${parsed.gameId} yet — pending (will retry)`);
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
    } else if (
      market.mType === MarketType.FOREX ||
      market.mType === MarketType.COMMODITIES ||
      market.mType === MarketType.STOCKS
    ) {
      // #180 Pyth-fed price markets. Same gt/lt SYMBOL:op:STRIKE
      // oracleRef shape as CRYPTO, but the symbol is drawn from the
      // PRICE_FEED_BY_SYMBOL allowlist (mirrored from src/lib via
      // ./price-feed-assets) and the class must match the mType.
      // Sponsor-side validator (aa-call-allowlist.ts) rejects bad
      // shapes at create time; this branch still guards because a
      // pre-#180 market created via direct chain write could carry
      // a malformed oracleRef, and the resolver must skip rather
      // than crash.
      const expectedClass: 'forex' | 'commodities' | 'stocks' =
        market.mType === MarketType.FOREX
          ? 'forex'
          : market.mType === MarketType.COMMODITIES
            ? 'commodities'
            : 'stocks';
      const classTag = expectedClass;

      const parsed = parsePriceFeedOracleRef(market.oracleRef, expectedClass);
      if (!parsed) {
        console.warn(
          `[${ts}] market ${i}: unparseable ${classTag} oracleRef "${market.oracleRef}" — skip`,
        );
        skipped++;
        continue;
      }
      const live = pythPrices.get(parsed.symbol);
      if (!live) {
        console.log(
          `[${ts}] market ${i}: no pyth price for ${parsed.symbol} — pending (transient, will retry)`,
        );
        skipped++;
        continue;
      }
      const ratio = live.conf / live.price;
      if (ratio > CONFIDENCE_REJECT_RATIO) {
        const bps = (ratio * 10_000).toFixed(1);
        console.log(
          `[${ts}] market ${i}: ${parsed.symbol} low confidence (${bps}bps > 50bps) — pending, retry next tick`,
        );
        skipped++;
        continue;
      }
      outcome = derivePriceFeedOutcome(parsed, live.price);
      reason = `${classTag} ${parsed.symbol} ${parsed.op} ${parsed.strike} · live ${live.price.toFixed(6)} (conf ${(ratio * 10_000).toFixed(1)}bps)`;
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

    // The same sender as the no-data path (one broadcast per tick, nonce and re-read pinned to one finalized block,
    // one error classifier). The re-read must still call for a price or result settlement.
    const sent = await sendOnce(keeperIo, keeperTick.gate, { functionName: 'resolveMarket', args: [i, outcome] }, (read) => {
      const again = decideAction(read.market, read.blockTimestamp, decideOpts);
      return again === 'fetch_and_resolve'
        ? null
        : `re-read at finalized block ${read.blockNumber} (time ${read.blockTimestamp}) gives ${again}`;
    });
    if (sent.kind === 'landed') {
      console.log(`[${ts}] market ${i}: RESOLVED ${label} · block ${sent.blockNumber} · tx ${sent.hash} · nonce ${sent.nonce}`);
      resolvedCount++;
    } else if (sent.kind === 'out_of_funds') {
      console.warn(`[${ts}] market ${i}: resolver wallet out of MON — stopping tick`);
      walletOutOfFunds = true;
    } else if (sent.kind === 'already_resolved') {
      console.warn(`[${ts}] market ${i}: already resolved elsewhere — continuing`);
    } else if (sent.kind === 'slot_taken' || sent.kind === 'unfinalized') {
      console.log(
        `[${ts}] market ${i}: resolveMarket deferred to the next tick (${sent.kind === 'slot_taken' ? 'one transaction per tick' : `a resolver transaction is not final yet, nonce ${sent.latest} at latest, ${sent.finalized} at the finalized block; nothing more is sent this tick`})`,
      );
      deferredPrice++;
    } else if (sent.kind === 'stale') {
      console.log(`[${ts}] market ${i}: ${sent.reason}; not sending this tick`);
    } else if (sent.kind === 'reread_failed') {
      console.warn(`[${ts}] market ${i}: re-read before resolveMarket failed (${sent.message}), not sending this tick`);
    } else if (sent.kind === 'receipt_timeout') {
      console.warn(
        `[${ts}] market ${i}: tx ${sent.hash} (nonce ${sent.nonce}) has no receipt yet; a later send reuses this nonce, so it cannot be paid twice`,
      );
    } else if (sent.kind === 'reverted') {
      console.warn(`[${ts}] market ${i}: tx reverted (hash ${sent.hash})`);
    } else if (sent.kind === 'not_yet') {
      console.warn(`[${ts}] market ${i}: resolveMarket reverted ${sent.errorName}, retry next tick`);
    } else if (sent.kind === 'nonce_unreadable') {
      console.warn(`[${ts}] market ${i}: could not read the resolver nonce (${sent.message}), not sending this tick`);
    } else {
      console.warn(`[${ts}] market ${i}: resolveMarket failed at nonce ${sent.nonce}: ${sent.message}`);
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
  if (oneSidedRefunds + forceRefunds + noDataDeferred + heldTwoSided > 0) {
    console.log(
      `[${ts}] no-data settlement${modeTag}: one-sided refunds ${oneSidedRefunds}, force refunds ${forceRefunds}, deferred ${noDataDeferred}, two-sided past 24h not force-refunded ${heldTwoSided}` +
        `${heldTwoSided > 0 ? ' (FORCE_REFUND_TWO_SIDED is off)' : ''}`,
    );
  }
  console.log(
    `[${ts}] tick done${modeTag} · scanned ${scanned} · skipped ${skipped} · resolved ${resolvedCount} · refunds ${refundCount}` +
      `${deferredPrice > 0 ? ` · price settlements deferred ${deferredPrice} (${deferReason(keeperTick.gate)})` : ''}`,
  );
}

/// Cron paths the Worker is allowed to ping on the Vercel side.
/// Keeping the type union narrow gives compile-time protection against
/// typos that would silently 404.
type VercelCronPath =
  | '/api/cron/aa-fast'
  | '/api/cron/aa-slow'
  | '/api/cron/pm-indexer'
  | '/api/cron/pm-maintenance'
  | '/api/cron/leaderboard';

/// Fire one HTTP cron tick against the Vercel app. Runs as a
/// "fire and forget" inside ctx.waitUntil so a slow Vercel response
/// doesn't block the market resolver. We don't await the body; the
/// status code alone tells us whether the bearer auth + handler ran.
async function pingVercelCron(env: Env, path: VercelCronPath): Promise<void> {
  if (!env.MAKO_APP_URL) return; // Vercel scheduling not configured.
  if (!env.CRON_SECRET) {
    // Loud, but only once per missing tick — better than silently
    // falling back to no-auth, which would expose the cron routes to
    // anyone who finds the URL.
    console.warn(`[cron] ${path}: CRON_SECRET unset — skipping`);
    return;
  }
  const url = `${env.MAKO_APP_URL.replace(/\/$/, '')}${path}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        // Vercel checks for this header on its own crons; setting it
        // here lets cron-auth.ts treat the Worker tick the same way
        // it treats Vercel-native cron triggers.
        'User-Agent': 'vercel-cron/1.0 (mako-auto-resolver)',
      },
    });
    if (!res.ok) {
      console.warn(`[cron] ${path} → ${res.status}`);
    }
  } catch (e) {
    console.warn(`[cron] ${path} fetch failed:`, shortErrorMessage(e));
  }
}

export default {
  // CF cron fires scheduled() at every trigger in wrangler.toml.
  // ctx.waitUntil keeps the Worker alive until runResolver finishes
  // (otherwise the event ends when scheduled() returns synchronously).
  //
  // Jobs on this per-minute tick (cadences tuned for Neon autosuspend —
  // #191; the 2 PM jobs are PAUSED):
  //   1. Market resolver (every minute — sports/crypto market lifecycle;
  //      chain-only, never touches Neon).
  //   2. AA fast cron (every 15 min — expires timed-out `pending` rows +
  //      recovers `sending` rows already stuck past the 5-min threshold;
  //      live bets/claims resolve inline in /api/aa/send).
  //   3. AA slow cron (every 30 min — sweeps stale rows + emits
  //      ambiguous-row alerts).
  //   4. PAUSED 2026-07-20 (#191) — Private-markets indexer (was every
  //      minute — runIndexerOnce against MakoPrivateMarketsV1). PM is
  //      dark; the per-minute DB wake burned Neon compute for nothing.
  //   5. PAUSED 2026-07-20 (#191) — Private-markets maintenance (was
  //      every 5 minutes — stale-pending sweep + resnapshot).
  //   6. Leaderboard indexer (every 30 min — appends main-market
  //      BetPlaced/Claimed/CreatorFeePaid rows to the #186 event
  //      ledger; cold-start backfill is the seed script's job, not
  //      this cron's).
  //
  // The Vercel pings live HERE (not in vercel.json) because Vercel
  // Hobby plan rejects sub-daily crons. The Worker fires them via
  // pingVercelCron with Bearer CRON_SECRET; the routes themselves
  // still gate via cron-auth.ts.
  //
  // Cron pings are gated by minute % 15 / minute % 30 against the CF
  // scheduledTime (epoch ms), not the Worker's wall clock at handler
  // entry, so behaviour is deterministic against CF's scheduled time
  // even under handler-entry skew. The 30-min jobs land on a subset of
  // the 15-min ticks (minute 0/30), so they never add a DB wakeup.
  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runResolver(env).catch((error) => {
        console.error('[resolver] tick error:', shortErrorMessage(error));
      }),
    );

    // Vercel cron pings — cadence tuned so Neon can autosuspend (#191,
    // 2026-07-20). Neon Free suspends after ~5 min idle and includes
    // 100 CU-hours/mo, so anything hitting the DB more often than the
    // suspend window keeps it resident 24/7 and drains the quota. The
    // DB-touching crons are therefore gated to intervals that leave real
    // idle gaps, and the 30-min jobs are ALIGNED onto an aa-fast tick so
    // they add no extra wakeups. (runResolver above is every-minute but
    // chain-only — it never touches Neon — so it's unaffected.)
    const minute = new Date(event.scheduledTime).getUTCMinutes();

    // aa-fast — every 15 min (was every minute). Janitor only: expires
    // timed-out `pending` rows + recovers `sending` rows already stuck past
    // SENDING_RECOVERY_THRESHOLD_MS (5 min). Live bets/claims resolve inline
    // in /api/aa/send, so a 15-min cadence only delays cleanup of an
    // ABANDONED op; a user retry recovers it sooner.
    if (minute % 15 === 0) {
      ctx.waitUntil(pingVercelCron(env, '/api/cron/aa-fast'));
    }

    // aa-slow + leaderboard — every 30 min (both were every 5 min), ALIGNED
    // with an aa-fast tick (minute 0/30 is a subset of the 15-min ticks) so
    // they piggyback an existing DB wakeup instead of creating new ones.
    // aa-slow = stale-row sweep + ambiguous-row alerts. leaderboard = #186
    // main-market event ledger; its read API caches 30-60s and the board
    // only shifts when bets/claims land, so 30-min indexing is fine.
    // (Cold-start population is scripts/seed-leaderboard.mts's job.)
    if (minute % 30 === 0) {
      ctx.waitUntil(pingVercelCron(env, '/api/cron/aa-slow'));
      ctx.waitUntil(pingVercelCron(env, '/api/cron/leaderboard'));
    }

    // PAUSED 2026-07-20 (#191): Private Markets is dark
    // (NEXT_PUBLIC_PM_ENABLED=false), so its indexer/maintenance crons were
    // waking Neon for a feature no user can reach. Re-enable both when PM
    // ships (#165/#168) — on a sleep-friendly cadence, not the old
    // every-minute / every-5-min.
    // if (minute % 15 === 0) ctx.waitUntil(pingVercelCron(env, '/api/cron/pm-indexer'));
    // if (minute % 30 === 0) ctx.waitUntil(pingVercelCron(env, '/api/cron/pm-maintenance'));
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
