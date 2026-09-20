// MIRROR_ORACLE_REF_PARSERS.
// The resolver's oracleRef parsers, copied in behaviour from
// cf-worker/src/index.ts L237-296 (crypto, football, basketball) and
// L636-667 (forex, commodities, stocks, with the class check). A market whose
// reference fails its type's parser is one the resolver skips on every tick,
// so it can never settle on its own: the watchdog raises `UO` for it.
//
// Keep each function identical to its resolver twin, quirks included (the
// crypto strike goes through Number() with no pattern, the price-feed strike
// through a pattern first).

import { hexToString } from 'viem';
import { CRYPTO_SYMBOLS, MARKET_TYPE, PRICE_FEED_CLASS, type PriceFeedClass } from './assets';

export function decodeOracleRefString(ref: string): string | null {
  try {
    const raw = hexToString(ref as `0x${string}`, { size: 32 });
    const decoded = raw.replace(/\0+$/, '').trim();
    return decoded || null;
  } catch {
    return null;
  }
}

export interface PriceRef {
  symbol: string;
  op: 'gt' | 'lt';
  strike: number;
}

export function parseCryptoOracleRef(ref: string): PriceRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [symbolPart, opPart, strikePart] = parts;
  if (!CRYPTO_SYMBOLS.includes(symbolPart)) return null;
  if (!['gt', 'lt'].includes(opPart)) return null;
  const strike = Number(strikePart);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { symbol: symbolPart, op: opPart as 'gt' | 'lt', strike };
}

export function parseFootballOracleRef(ref: string): { matchId: string } | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [matchIdPart, typePart, paramPart] = parts;
  if (!/^\d+$/.test(matchIdPart)) return null;
  if (!['home_win', 'away_win', 'draw', 'over', 'under'].includes(typePart)) return null;
  const param = Number(paramPart);
  if (!Number.isFinite(param) || param < 0) return null;
  return { matchId: matchIdPart };
}

export function parseBasketballOracleRef(ref: string): { gameId: number } | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [gameIdPart, typePart, paramPart] = parts;
  if (!/^\d+$/.test(gameIdPart)) return null;
  if (!['home_win', 'away_win', 'over', 'under'].includes(typePart)) return null;
  const param = Number(paramPart);
  if (!Number.isFinite(param) || param < 0) return null;
  return { gameId: Number(gameIdPart) };
}

export function parsePriceFeedOracleRef(ref: string, expectedClass: PriceFeedClass): PriceRef | null {
  const decoded = decodeOracleRefString(ref);
  if (!decoded) return null;
  const parts = decoded.split(':').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const [symbolPart, opPart, strikePart] = parts;
  if (opPart !== 'gt' && opPart !== 'lt') return null;
  if (!/^\+?(\d+\.\d+|\d+|\.\d+)$/.test(strikePart)) return null;
  const strike = Number(strikePart);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const cls = PRICE_FEED_CLASS.get(symbolPart);
  if (!cls) return null;
  if (cls !== expectedClass) return null;
  return { symbol: symbolPart, op: opPart, strike };
}

const CLASS_BY_TYPE: Record<number, PriceFeedClass> = {
  [MARKET_TYPE.FOREX]: 'forex',
  [MARKET_TYPE.COMMODITIES]: 'commodities',
  [MARKET_TYPE.STOCKS]: 'stocks',
};

/// What the resolver would do with this reference.
/// - `exempt`: MAKO, resolved by hand; the reference is never interpreted.
/// - `supported`: the type's parser accepts it; `symbol` is set for price types.
/// - `unsupported`: the resolver skips the market forever.
export type RefVerdict = { kind: 'exempt' } | { kind: 'supported'; symbol?: string } | { kind: 'unsupported' };

export function classifyOracleRef(mType: number, ref: string): RefVerdict {
  switch (mType) {
    case MARKET_TYPE.MAKO:
      return { kind: 'exempt' };
    case MARKET_TYPE.CRYPTO: {
      const p = parseCryptoOracleRef(ref);
      return p ? { kind: 'supported', symbol: p.symbol } : { kind: 'unsupported' };
    }
    case MARKET_TYPE.FOOTBALL:
      return parseFootballOracleRef(ref) ? { kind: 'supported' } : { kind: 'unsupported' };
    case MARKET_TYPE.BASKETBALL:
      return parseBasketballOracleRef(ref) ? { kind: 'supported' } : { kind: 'unsupported' };
    case MARKET_TYPE.FOREX:
    case MARKET_TYPE.COMMODITIES:
    case MARKET_TYPE.STOCKS: {
      const p = parsePriceFeedOracleRef(ref, CLASS_BY_TYPE[mType]);
      return p ? { kind: 'supported', symbol: p.symbol } : { kind: 'unsupported' };
    }
    default:
      return { kind: 'unsupported' };
  }
}
