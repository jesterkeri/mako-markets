// Pure helpers for the handlers: how a contract value maps to an entity value, and how days are named.

import type { Enum } from 'envio';

type Category = Enum<'Category'>;
type PoolStatus = Enum<'PoolStatus'>;
type RoundSide = Enum<'RoundSide'>;
type RoundRefundReason = Enum<'RoundRefundReason'>;

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

/// MakoRoundsV1.Side: None (0), Up (1), Down (2). An entry is never None.
export function roundSideOf(side: bigint): RoundSide {
  if (side === 1n) return 'Up';
  if (side === 2n) return 'Down';
  throw new Error(`unexpected round side ${side}`);
}

/// MakoRoundsV1.Outcome: None (0), Up (1), Down (2). A settled round is never None.
export function roundOutcomeOf(outcome: bigint): 'Up' | 'Down' {
  return roundSideOf(outcome);
}

/// MakoRoundsV1.RefundReason: None (0), OneSided (1), Tie (2), NoPrice (3). A refund always has a reason.
export function refundReasonOf(reason: bigint): RoundRefundReason {
  if (reason === 1n) return 'OneSided';
  if (reason === 2n) return 'Tie';
  if (reason === 3n) return 'NoPrice';
  throw new Error(`unexpected refund reason ${reason}`);
}

/// The UTC day a timestamp falls in: its id ("2026-10-01") and its first second.
export function dayOf(timestamp: number): { id: string; start: number } {
  const start = Math.floor(timestamp / DAY) * DAY;
  return { id: new Date(start * 1000).toISOString().slice(0, 10), start };
}

export const positionId = (wallet: string, poolId: string): string => `${wallet}-${poolId}`;
export const walletDayId = (wallet: string, day: string): string => `${wallet}-${day}`;
