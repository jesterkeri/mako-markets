// What a new pool is made of (10a): its question, its settlement reference, and its two times, from the choices a
// creator makes. References and sports questions are byte-for-byte the formats the old create page produced
// (src/app/create/_components/CreateClient.tsx, removed once /create redirected here) and the resolver parses
// (cf-worker/src/index.ts parse*OracleRef; for football over/under it also matches the question text), so a pool made
// here settles exactly like one made there. Price questions state the rule the resolver settles on: the price at the
// close second, in fixed UTC (naming plan r8 §4).

import { MarketType } from './contract';
import {
  MAX_DURATION_SEC,
  SHEET_HOLD_SEC,
  sportsTimestamps,
  suggestedCryptoBettingCloseTimeMirror,
  TX_LANDING_BUFFER_SEC,
  validateMarketTimestamps,
} from './market-timing';

export type PriceKind = 'crypto' | 'forex' | 'commodities' | 'stocks';
export type CreateKind = PriceKind | 'football' | 'basketball';

/// How long a price pool runs, as the current create page offers it.
export const DURATIONS: readonly { label: string; short: string; seconds: number }[] = [
  { label: '5 minutes', short: '5M', seconds: 300 },
  { label: '10 minutes', short: '10M', seconds: 600 },
  { label: '1 hour', short: '1H', seconds: 3600 },
  { label: '6 hours', short: '6H', seconds: 21600 },
  { label: '12 hours', short: '12H', seconds: 43200 },
  { label: '24 hours', short: '24H', seconds: 86400 },
  { label: '3 days', short: '3D', seconds: 259200 },
  { label: '7 days', short: '7D', seconds: 604800 },
];

const PRICE_TYPE: Record<PriceKind, MarketType> = {
  crypto: MarketType.CRYPTO,
  forex: MarketType.FOREX,
  commodities: MarketType.COMMODITIES,
  stocks: MarketType.STOCKS,
};

export type FootballQuestion = 'home_win' | 'away_win' | 'draw' | 'over';
export type BasketballQuestion = 'home_win' | 'away_win' | 'over' | 'under';

export type Fixture = { id: string | number; homeTeam: string; awayTeam: string; kickoffIso: string };
export type Game = { id: string | number; homeTeam: string; visitorTeam: string; tipoffIso: string };

export type CreateDraft =
  | { kind: PriceKind; symbol: string; direction: 'above' | 'below'; strike: number; durationSec: number }
  | { kind: 'football'; fixture: Fixture; question: FootballQuestion }
  | { kind: 'basketball'; game: Game; question: BasketballQuestion; total: number };

export type BuiltPool = {
  mType: MarketType;
  question: string;
  /// The settlement reference as text (at most 32 bytes); `toBytes32` makes the on-chain value.
  oracleRef: string;
  bettingCloseTime: bigint;
  closeTime: bigint;
};

export type BuildResult = { ok: true; pool: BuiltPool } | { ok: false; reason: string };

const bytes = (s: string) => new TextEncoder().encode(s).length;

/// The target as a title shows it: exactly the digits of the strike text (the resolver settles on those), the integer
/// part grouped in threes the same way in every browser: "84,546", "9.70545", "0.0275", "151.234". ".5" shows as
/// "0.5" and leading zeros go. The question is stored on chain, so no locale or Intl. Null on an exponent form, which
/// no parser accepts and a title cannot show plainly, and on more than 18 decimal places, the resolver's limit
/// (pool-rules.ts CRYPTO_REF / FEED_STRIKE).
export function groupStrike(text: string): string | null {
  const m = /^(\d*)(?:\.(\d{1,18}))?$/.exec(text);
  if (!m || (m[1] === '' && m[2] === undefined)) return null;
  const int = (m[1].replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return m[2] === undefined ? int : `${int}.${m[2]}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

/// The price-check moment as a title states it: "10:04 UTC on Wed 28 Oct", with seconds only when they are not :00
/// ("20:14:03 UTC on Tue 27 Oct"). Built from getUTC* and fixed names, never Intl, whose output varies by ICU
/// ("Sept"); no year, since a pool runs at most 7 days.
export function utcMoment(sec: number): string {
  const d = new Date(sec * 1000);
  const s = d.getUTCSeconds();
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${s ? `:${pad2(s)}` : ''} UTC on ${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/// The asset as a title names it: forex and commodity pairs split 3/3 ("EUR/USD", "XAU/USD"), else the symbol.
export function priceSubject(mType: MarketType, symbol: string): string {
  return (mType === MarketType.FOREX || mType === MarketType.COMMODITIES) && /^[A-Z]{6}$/.test(symbol) ? `${symbol.slice(0, 3)}/${symbol.slice(3)}` : symbol;
}

/// The grouped target, with "$" for crypto and stocks only. Null when groupStrike is.
export function priceTarget(mType: MarketType, strikeText: string): string | null {
  const g = groupStrike(strikeText);
  if (g === null) return null;
  return mType === MarketType.CRYPTO || mType === MarketType.STOCKS ? `$${g}` : g;
}

/// "Will BTC be above $84,546 at 10:04 UTC on Wed 28 Oct?": the rule the resolver settles on (strictly above or below
/// the strike, equality is NO, at the close second). Null when the target cannot be shown.
export function priceTitle(mType: MarketType, symbol: string, op: 'gt' | 'lt', strikeText: string, closeSec: number): string | null {
  const target = priceTarget(mType, strikeText);
  return target === null ? null : `Will ${priceSubject(mType, symbol)} be ${op === 'gt' ? 'above' : 'below'} ${target} at ${utcMoment(closeSec)}?`;
}
const MAX_QUESTION_BYTES = 200;

/// Everything the create call needs, or the reason it cannot be made yet. `nowSec` is the moment the confirm sheet
/// opened: a price pool closes on a whole minute, from now plus the landing buffer and the sheet's 30 s hold, rounded
/// up (7D: from now plus the capped run, rounded down); sports pools take their times from the fixture.
export function buildPool(d: CreateDraft, nowSec: number): BuildResult {
  let pool: BuiltPool;
  let strict = false;
  if (d.kind === 'football' || d.kind === 'basketball') {
    const iso = d.kind === 'football' ? d.fixture.kickoffIso : d.game.tipoffIso;
    const startMs = new Date(iso).getTime();
    if (!Number.isFinite(startMs)) return { ok: false, reason: 'This fixture has no valid start time.' };
    const { bettingCloseTime, closeTime } = sportsTimestamps(Math.floor(startMs / 1000), d.kind);
    strict = true;
    if (d.kind === 'football') {
      const { homeTeam, awayTeam } = d.fixture;
      const question = {
        home_win: `Will ${homeTeam} beat ${awayTeam}?`,
        away_win: `Will ${awayTeam} beat ${homeTeam}?`,
        draw: `Will ${homeTeam} vs ${awayTeam} end in a draw?`,
        over: `Over 2.5 goals in ${homeTeam} vs ${awayTeam}?`,
      }[d.question];
      pool = { mType: MarketType.FOOTBALL, question, oracleRef: `${d.fixture.id}:${d.question}:${d.question === 'over' ? '2.5' : '0'}`, bettingCloseTime, closeTime };
    } else {
      const { homeTeam, visitorTeam } = d.game;
      const isTotal = d.question === 'over' || d.question === 'under';
      if (isTotal && !(Number.isFinite(d.total) && d.total > 0)) return { ok: false, reason: 'Enter the total points line.' };
      const question = {
        home_win: `Will ${homeTeam} beat ${visitorTeam}?`,
        away_win: `Will ${visitorTeam} beat ${homeTeam}?`,
        over: `Over ${d.total} total points in ${visitorTeam} @ ${homeTeam}?`,
        under: `Under ${d.total} total points in ${visitorTeam} @ ${homeTeam}?`,
      }[d.question];
      pool = { mType: MarketType.BASKETBALL, question, oracleRef: `${d.game.id}:${d.question}:${isTotal ? String(d.total) : '0'}`, bettingCloseTime, closeTime };
    }
  } else {
    const symbol = d.symbol.trim().toUpperCase();
    if (!symbol) return { ok: false, reason: 'Pick an asset.' };
    if (!(Number.isFinite(d.strike) && d.strike > 0)) return { ok: false, reason: 'Enter a target price above 0.' };
    const strikeText = String(d.strike);
    if (/\.\d{19}/.test(strikeText)) return { ok: false, reason: 'This target has more than 18 decimal places, which a pool cannot settle. Use fewer.' };
    const op = d.direction === 'above' ? 'gt' : 'lt';
    // 7D keeps today's cap and rounds down, so a fast device clock keeps at least 60 s of tolerance (plan r8 §4).
    const closeSec =
      d.durationSec + TX_LANDING_BUFFER_SEC + SHEET_HOLD_SEC > MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC
        ? Math.floor((nowSec + MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC) / 60) * 60
        : Math.ceil((nowSec + d.durationSec + TX_LANDING_BUFFER_SEC + SHEET_HOLD_SEC) / 60) * 60;
    const question = priceTitle(PRICE_TYPE[d.kind], symbol, op, strikeText, closeSec);
    if (question === null) return { ok: false, reason: 'This target is too small or too large for a pool to settle.' };
    const bettingCloseTime = suggestedCryptoBettingCloseTimeMirror(nowSec, closeSec);
    pool = { mType: PRICE_TYPE[d.kind], question, oracleRef: `${symbol}:${op}:${strikeText}`, bettingCloseTime, closeTime: BigInt(closeSec) };
  }
  if (bytes(pool.oracleRef) > 32) return { ok: false, reason: 'This choice does not fit in a pool reference. Pick another.' };
  // MakoMarketsV4.createMarket: BadQuestion unless 0 < bytes(question) <= 200.
  if (bytes(pool.question) > MAX_QUESTION_BYTES) return { ok: false, reason: 'This question is too long for a pool. Pick a shorter one.' };
  const invalid = validateMarketTimestamps({ nowSec, bettingCloseTime: pool.bettingCloseTime, closeTime: pool.closeTime, strictBettingBeforeClose: strict });
  if (invalid) return { ok: false, reason: invalid.replace(/\s+—\s+/g, ': ') };
  return { ok: true, pool };
}
