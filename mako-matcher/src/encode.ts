// The settlement call (plan 4.4): `matchOrders` built from stored records ONLY. `takerSig` comes from the taker's
// record, and `makers`, `makerSigs` and `fills` from ONE list of maker records, so an index can never point at
// another record's signature. The market of every maker must be the taker's, or nothing is built.
import { decodeFunctionData, type Hex } from 'viem';
import { encodeCall, EXCHANGE_ABI, type OrderTuple } from './abi';
import { canonicalUint } from './order';

/// A stored order and its signature as the market object hands them over (wire shape).
export interface Rec {
  hash: Hex;
  signature: Hex;
  order: { salt: string; maker: Hex; marketId: string; option: number; isBuy: boolean; price: number; size: string; expiration: string; nonce: string };
}

export interface WireProposal {
  kind: 'direct' | 'mint' | 'merge';
  marketId: string;
  taker: Rec;
  makers: Rec[];
  fills: string[];
  takerFill: string;
}

const U256 = (1n << 256n) - 1n;
const HEX32 = /^0x[0-9a-f]{64}$/;

function parseRec(r: unknown): Rec | null {
  if (typeof r !== 'object' || r === null) return null;
  const x = r as { hash?: unknown; signature?: unknown; order?: Record<string, unknown> };
  if (typeof x.hash !== 'string' || !HEX32.test(x.hash)) return null;
  if (typeof x.signature !== 'string' || !/^0x([0-9a-f]{2})+$/.test(x.signature)) return null;
  const o = x.order;
  if (!o || typeof o.maker !== 'string' || !/^0x[0-9a-f]{40}$/.test(o.maker)) return null;
  for (const k of ['salt', 'marketId', 'size', 'expiration', 'nonce'] as const) if (canonicalUint(o[k], U256) === null) return null;
  if (typeof o.option !== 'number' || !Number.isInteger(o.option) || typeof o.price !== 'number' || !Number.isInteger(o.price) || typeof o.isBuy !== 'boolean') return null;
  return { hash: x.hash as Hex, signature: x.signature as Hex, order: o as Rec['order'] };
}

/// Strict parse of the body the market object sends to the settler.
export function parseProposal(b: unknown): WireProposal | null {
  if (typeof b !== 'object' || b === null) return null;
  const p = b as Record<string, unknown>;
  if (p.kind !== 'direct' && p.kind !== 'mint' && p.kind !== 'merge') return null;
  if (canonicalUint(p.marketId, U256) === null || canonicalUint(p.takerFill, U256) === null) return null;
  const taker = parseRec(p.taker);
  if (!taker || !Array.isArray(p.makers) || !Array.isArray(p.fills) || p.makers.length === 0 || p.makers.length !== p.fills.length) return null;
  const makers = p.makers.map(parseRec);
  if (makers.some((m) => m === null) || !p.fills.every((f) => canonicalUint(f, U256) !== null)) return null;
  return { kind: p.kind, marketId: p.marketId as string, taker, makers: makers as Rec[], fills: p.fills as string[], takerFill: p.takerFill as string };
}

export function toTuple(o: Rec['order']): OrderTuple {
  return {
    salt: BigInt(o.salt),
    maker: o.maker,
    marketId: BigInt(o.marketId),
    option: o.option,
    isBuy: o.isBuy,
    price: o.price,
    size: BigInt(o.size),
    expiration: BigInt(o.expiration),
    nonce: BigInt(o.nonce),
  };
}

export type Encoded = { ok: true; data: Hex } | { ok: false; reason: 'market_mismatch'; hash: Hex };

export function encodeMatch(p: WireProposal): Encoded {
  // The contract's MarketMismatch rule, mirrored: build and send nothing.
  for (const m of p.makers) if (m.order.marketId !== p.taker.order.marketId) return { ok: false, reason: 'market_mismatch', hash: m.hash };
  const data = encodeCall('matchOrders', [
    toTuple(p.taker.order),
    p.taker.signature,
    p.makers.map((m) => toTuple(m.order)),
    p.makers.map((m) => m.signature),
    p.fills.map((f) => BigInt(f)),
    BigInt(p.takerFill),
  ]);
  return { ok: true, data };
}

export interface DecodedMatch {
  taker: OrderTuple;
  takerSig: Hex;
  makers: OrderTuple[];
  makerSigs: Hex[];
  fills: bigint[];
  takerFill: bigint;
}

/// The arguments of a `matchOrders` call from its input bytes (the calldata that was simulated or mined).
export function decodeMatch(data: Hex): DecodedMatch | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: EXCHANGE_ABI, data });
    if (functionName !== 'matchOrders' || !args) return null;
    const a = args as unknown as [OrderTuple, Hex, OrderTuple[], Hex[], bigint[], bigint];
    return { taker: a[0], takerSig: a[1], makers: [...a[2]], makerSigs: [...a[3]], fills: [...a[4]], takerFill: a[5] };
  } catch {
    return null;
  }
}
