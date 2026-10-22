// How the redesign names and lists Pools (the V4 markets).

import { hexToString } from 'viem';

import { MarketType, type MarketWithId } from './contract';
import type { MakoRelease } from './mako-release-record';
import { noMultiplier, yesMultiplier } from './mocks';
import { priceTitle } from './pool-create';
import { parseOracleRef } from './pool-rules';

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

/// An old app wording of a price pool (the create page's "in <duration>" templates before naming plan r8), only when
/// its symbol, direction and strike are exactly the pool's raw settlement reference; else null. No URL, "@" or free
/// text can pass, and the text cannot contradict the reference.
const OLD_WORDING = /^Will ([A-Z0-9]{1,10}) (close|trade|settle) (above|below) \$?(\d[\d,]*(?:\.\d+)?) in (5 minutes|10 minutes|1 hour|6 hours|12 hours|24 hours|3 days|7 days)\?$/;
export function oldWording(m: Pick<MarketWithId, 'question' | 'oracleRef'>): string | null {
  const x = OLD_WORDING.exec(m.question);
  if (!x) return null;
  let raw: string;
  try {
    raw = hexToString(m.oracleRef, { size: 32 }).replace(/\0+$/, '');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [symbol, op, strike] = parts;
  return x[1] === symbol && (x[3] === 'above' ? 'gt' : 'lt') === op && x[4].replace(/,/g, '') === strike ? m.question : null;
}

/// The line under a built title whose pool carries a vetted old wording (MarketWithId.originalWording). It never says
/// the two texts mean the same thing.
export function firstWorded(originalWording: string): string {
  return `First worded as “${originalWording}”. That wording may not match the rule. The title above is built from the price check this pool settles on.`;
}

const PRICE_TYPES: ReadonlySet<MarketType> = new Set([MarketType.CRYPTO, MarketType.FOREX, MarketType.COMMODITIES, MarketType.STOCKS]);

/// A pool's title, under the reviewed record of the contract it was read from (naming plan r8 §5). Price pools:
/// 1. closing at or after their class's Data Streams cutover with a reference the resolver reads: the title is built
///    from that reference and the close time, the rule the pool settles on; `originalWording` is the stored question
///    when it is exactly the record's vetted wording for this id and still an old wording that agrees with the ref.
/// 2. closing before the cutover: the stored question if it is an old app wording that agrees with the ref, else
///    `Pool #N` (they settled on older sources, so no exact-second claim).
/// 3. at or after the cutover with a reference the resolver cannot read: `Pool #N`; the stored text is never shown.
/// Sports and house (MAKO) pools: the stored question.
export function poolTitle(
  m: Pick<MarketWithId, 'id' | 'mType' | 'oracleRef' | 'question' | 'closeTime'>,
  release: MakoRelease,
): { title: string; originalWording?: string } {
  if (!PRICE_TYPES.has(m.mType)) return { title: m.question };
  const fallback = `Pool #${m.id.toString()}`;
  const since = m.mType === MarketType.CRYPTO ? release.dsSince.crypto : release.dsSince.rwa;
  if (m.closeTime < BigInt(since)) return { title: oldWording(m) ?? fallback };
  const ref = parseOracleRef(m);
  const title = ref?.kind === 'price' ? priceTitle(m.mType, ref.symbol, ref.op, ref.strike, Number(m.closeTime)) : null;
  if (title === null) return { title: fallback };
  const vetted = (release.vettedWording as Readonly<Record<string, string>>)[m.id.toString()];
  return vetted !== undefined && vetted === m.question && oldWording(m) !== null ? { title, originalWording: m.question } : { title };
}
