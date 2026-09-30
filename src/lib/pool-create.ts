// What a new pool is made of (10a): its question, its settlement reference, and its two times, from the choices a
// creator makes. Byte-for-byte the formats the current create page produces (src/app/create/_components/
// CreateClient.tsx) and the resolver parses (cf-worker/src/index.ts parse*OracleRef; for football over/under it
// also matches the question text), so a pool made here settles exactly like one made there.

import { MarketType } from './contract';
import {
  MAX_DURATION_SEC,
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

/// The question verb per price kind, as the current create page words it.
const PRICE_VERB: Record<Exclude<PriceKind, 'crypto'>, string> = { forex: 'trade', commodities: 'settle', stocks: 'close' };

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

const durationLabel = (sec: number) => DURATIONS.find((d) => d.seconds === sec)?.label ?? `${sec}s`;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/// The target as the question shows it: exactly the digits the reference carries (the resolver settles on those),
/// grouped the same way in every browser: "84,546", "9.70545", "0.0275". The question is stored on chain, so it must
/// not depend on the creator's locale. Null when String() writes the number with an exponent, which the forex,
/// commodities and stocks parsers refuse and a question cannot show plainly.
function plainStrike(n: number): string | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(n));
  return m ? `${BigInt(m[1]).toLocaleString('en-US')}${m[2] ? `.${m[2]}` : ''}` : null;
}
const MAX_QUESTION_BYTES = 200;

/// Everything the create call needs, or the reason it cannot be made yet. `nowSec` is the moment of submitting:
/// price pools run from now; sports pools take their times from the fixture.
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
    const shown = plainStrike(d.strike);
    if (shown === null) return { ok: false, reason: 'This target is too small or too large for a pool to settle.' };
    const closeSec = nowSec + Math.min(d.durationSec + TX_LANDING_BUFFER_SEC, MAX_DURATION_SEC - TX_LANDING_BUFFER_SEC);
    const bettingCloseTime = suggestedCryptoBettingCloseTimeMirror(nowSec, closeSec);
    const question =
      d.kind === 'crypto'
        ? `Will ${symbol} ${d.direction === 'above' ? 'close above' : 'close below'} $${shown} in ${durationLabel(d.durationSec)}?`
        : `Will ${symbol} ${PRICE_VERB[d.kind]} ${d.direction} ${d.strike} in ${durationLabel(d.durationSec)}?`;
    pool = { mType: PRICE_TYPE[d.kind], question, oracleRef: `${symbol}:${d.direction === 'above' ? 'gt' : 'lt'}:${d.strike}`, bettingCloseTime, closeTime: BigInt(closeSec) };
  }
  if (bytes(pool.oracleRef) > 32) return { ok: false, reason: 'This choice does not fit in a pool reference. Pick another.' };
  // MakoMarketsV4.createMarket: BadQuestion unless 0 < bytes(question) <= 200.
  if (bytes(pool.question) > MAX_QUESTION_BYTES) return { ok: false, reason: 'This question is too long for a pool. Pick a shorter one.' };
  const invalid = validateMarketTimestamps({ nowSec, bettingCloseTime: pool.bettingCloseTime, closeTime: pool.closeTime, strictBettingBeforeClose: strict });
  if (invalid) return { ok: false, reason: invalid.replace(/\s+—\s+/g, ': ') };
  return { ok: true, pool };
}
