// How the redesign names and lists Pools (the V4 markets).

import { MarketType, type MarketWithId } from './contract';
import { noMultiplier, yesMultiplier } from './mocks';

const CATEGORY: Record<MarketType, string> = {
  [MarketType.FOOTBALL]: 'Football',
  [MarketType.CRYPTO]: 'Crypto',
  [MarketType.BASKETBALL]: 'NBA',
  [MarketType.FOREX]: 'Forex',
  [MarketType.COMMODITIES]: 'Commodities',
  [MarketType.STOCKS]: 'Stocks',
  [MarketType.MAKO]: 'Mako',
};

export function poolCategory(mType: MarketType): string {
  return CATEGORY[mType] ?? 'Pool';
}

/// Pools still taking bets at `nowSec`, soonest to close first.
export function openPools(markets: readonly MarketWithId[], nowSec: number): MarketWithId[] {
  const now = BigInt(Math.floor(nowSec));
  return markets
    .filter((m) => !m.resolved && m.bettingCloseTime > now)
    .sort((a, b) => (a.bettingCloseTime < b.bettingCloseTime ? -1 : a.bettingCloseTime > b.bettingCloseTime ? 1 : 0));
}

/// "Football · YES 2.05x · NO 1.90x" while both sides have money; with one side empty a payout cannot be
/// quoted, so it counts the bets instead ("Football · 1 bet").
export function poolMeta(m: MarketWithId): string {
  const cat = poolCategory(m.mType);
  const yes = yesMultiplier(m);
  const no = noMultiplier(m);
  if (yes > 0 && no > 0) return `${cat} · YES ${yes.toFixed(2)}x · NO ${no.toFixed(2)}x`;
  const bets = m.yesBettorCount + m.noBettorCount;
  return `${cat} · ${bets} ${bets === 1 ? 'bet' : 'bets'}`;
}
