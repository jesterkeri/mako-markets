// A model of the exchange's `matchOrders` step-5 checks (src/MakoOutcomeExchangeV1.sol `_matchChecks`, `_field`,
// `_kind`, at mako-contracts e386bf4), written from that source and checked against the shared vectors'
// expected errors (test/match.test.ts). It lets the matcher's proposals be judged by the rules that would
// refuse them on chain, not by the matcher's own logic.
import type { Hex } from 'viem';

export interface MOrder {
  maker: Hex;
  marketId: bigint;
  option: number;
  isBuy: boolean;
  price: number;
  size: bigint;
}

const LOT = 10_000n;

export function modelErrors(
  taker: MOrder,
  makers: MOrder[],
  fills: bigint[],
  takerFill: bigint,
  nOpt: number,
  refused: (a: Hex) => boolean,
): string | null {
  const n = makers.length;
  if (n === 0 || n > 10) return 'BadMakerCount';
  if (fills.length !== n) return 'LengthMismatch';
  for (const m of makers) if (m.marketId !== taker.marketId) return 'MarketMismatch';
  for (const o of [taker, ...makers]) if (o.price === 0 || o.price > 99 || o.size === 0n || o.size % LOT !== 0n || o.option >= nOpt) return 'BadOrderField';
  // _kind
  let direct = true;
  for (const m of makers) if (m.option !== taker.option || m.isBuy === taker.isBuy) direct = false;
  let kind: 'direct' | 'mint' | 'merge';
  if (direct) kind = 'direct';
  else {
    if (n !== nOpt - 1) return 'WrongKind';
    const seen = new Set<number>([taker.option]);
    for (const m of makers) {
      if (m.isBuy !== taker.isBuy || seen.has(m.option)) return 'WrongKind';
      seen.add(m.option);
    }
    kind = taker.isBuy ? 'mint' : 'merge';
  }
  if (takerFill === 0n || takerFill % LOT !== 0n) return 'FillMismatch';
  let sum = 0n;
  for (const f of fills) {
    if (f === 0n || f % LOT !== 0n) return 'FillMismatch';
    if (kind === 'direct') sum += f;
    else if (f !== takerFill) return 'FillMismatch';
  }
  if (kind === 'direct' && sum !== takerFill) return 'FillMismatch';
  for (const m of makers) if (m.maker === taker.maker) return 'SelfMatch';
  if (kind === 'direct') {
    for (const m of makers) if (taker.isBuy ? m.price > taker.price : m.price < taker.price) return 'PriceNotCrossed';
  } else {
    const ps = makers.reduce((a, m) => a + m.price, 0);
    if (ps > 100) return 'SetPriceSum';
    const tp = 100 - ps;
    if (kind === 'mint' ? tp > taker.price : tp < taker.price) return 'PriceNotCrossed';
  }
  if (refused(taker.maker)) return 'PartyRefused';
  for (const m of makers) if (refused(m.maker)) return 'PartyRefused';
  return null;
}
