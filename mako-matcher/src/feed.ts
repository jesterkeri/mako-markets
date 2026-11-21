// The book feed (plan 6.2 "Book feed"): aggregated price levels only. Never a signature, a maker, an order hash
// or a salt.
import type { BookOrder } from './book';

export interface Level {
  option: number;
  side: 'buy' | 'sell';
  price: number;
  /// Remaining size in share base units, a decimal string.
  size: string;
  orders: number;
}

export interface BookFeed {
  market: string;
  asOf: number;
  levels: Level[];
}

export function buildFeed(market: bigint, orders: BookOrder[], nowMs: number): BookFeed {
  const nowS = BigInt(Math.floor(nowMs / 1000));
  const acc = new Map<string, { level: Level; size: bigint }>();
  for (const o of orders) {
    if (o.remaining <= 0n || o.expiration <= nowS) continue;
    const side = o.isBuy ? 'buy' : 'sell';
    const key = `${o.option}:${side}:${o.price}`;
    const e = acc.get(key) ?? { level: { option: o.option, side, price: o.price, size: '0', orders: 0 }, size: 0n };
    e.size += o.remaining;
    e.level.orders += 1;
    acc.set(key, e);
  }
  const levels = [...acc.values()].map((e) => ({ ...e.level, size: e.size.toString() }));
  // Bids best (highest) first, asks best (lowest) first, grouped by option.
  levels.sort((a, b) => a.option - b.option || (a.side === b.side ? (a.side === 'buy' ? b.price - a.price : a.price - b.price) : a.side === 'buy' ? -1 : 1));
  return { market: market.toString(), asOf: nowMs, levels };
}
