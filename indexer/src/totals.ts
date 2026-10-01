// Pure helpers for the handlers: how a contract value maps to an entity value, and how days are named.

import type { Enum } from 'envio';

type Category = Enum<'Category'>;
type PoolStatus = Enum<'PoolStatus'>;

const DAY = 86_400;

/// MakoMarketsV4.MarketType, in contract order: FOOTBALL, CRYPTO, BASKETBALL, FOREX, COMMODITIES, STOCKS, MAKO.
const CATEGORIES: readonly Category[] = ['Football', 'Crypto', 'Basketball', 'Forex', 'Commodities', 'Stocks', 'Mako'];

export function categoryOf(mType: bigint): Category {
  const c = CATEGORIES[Number(mType)];
  if (c === undefined || mType < 0n) throw new Error(`unknown MarketType ${mType}`);
  return c;
}

/// MakoMarketsV4.Outcome: UNRESOLVED (0), YES (1), NO (2), REFUND (3). A resolved pool is never UNRESOLVED.
export function statusOf(outcome: bigint): PoolStatus {
  if (outcome === 1n) return 'Yes';
  if (outcome === 2n) return 'No';
  if (outcome === 3n) return 'Refund';
  throw new Error(`unexpected resolved outcome ${outcome}`);
}

/// The UTC day a timestamp falls in: its id ("2026-10-01") and its first second.
export function dayOf(timestamp: number): { id: string; start: number } {
  const start = Math.floor(timestamp / DAY) * DAY;
  return { id: new Date(start * 1000).toISOString().slice(0, 10), start };
}

export const positionId = (wallet: string, poolId: string): string => `${wallet}-${poolId}`;
export const walletDayId = (wallet: string, day: string): string => `${wallet}-${day}`;
