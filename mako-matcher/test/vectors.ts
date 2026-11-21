// The shared vectors (data/order-abi.json, a vendored copy of mako-contracts test/vectors/order-abi.json), made
// easy to read. Every private key in them is derived from a public label and controls nothing.
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { OrderTuple } from '../src/abi';
import { ORDER_TYPES, DOMAIN_NAME, DOMAIN_VERSION } from '../src/order';
import vectors from '../data/order-abi.json';

export const V = vectors as unknown as {
  keys: Record<string, { privateKey: Hex; address: Hex }>;
  safes: Record<string, { address: Hex; owner: string; ownerAddress: Hex; singleton: Hex; fallbackHandler: Hex }>;
  domains: Record<string, { chainId: number; verifyingContract: Hex; separator: Hex }>;
  orders: Record<string, { party: string; kind: 'eoa' | 'safe'; fields: Record<string, unknown> }>;
  signed: Record<string, Record<string, { orderHash: Hex; eoaSignature?: Hex; safeSignature?: Hex; safeMsgHash?: Hex }>>;
  types: Record<string, { type: string; hash: Hex }>;
  calls: { id: string; takerSig: Hex; makerSigs: Hex[]; calldata: Hex; taker: string; makers: string[]; fills: string[]; takerFill: string; expect: { result: string } }[];
};

export function toTuple(f: Record<string, unknown>): OrderTuple {
  return {
    salt: BigInt(f.salt as string),
    maker: (f.maker as string).toLowerCase() as Hex,
    marketId: BigInt(f.marketId as string),
    option: Number(f.option),
    isBuy: Boolean(f.isBuy),
    price: Number(f.price),
    size: BigInt(f.size as string),
    expiration: BigInt(f.expiration as string),
    nonce: BigInt(f.nonce as string),
  };
}

export interface VecOrder {
  name: string;
  order: OrderTuple;
  signature: Hex;
  hash: Hex;
}

/// An order from the vectors with its signature under `domain` (default: the testnet exchange).
export function vec(name: string, domain = 'testnet'): VecOrder {
  const o = V.orders[name];
  const s = V.signed[domain][name];
  return { name, order: toTuple(o.fields), signature: (s.eoaSignature ?? s.safeSignature) as Hex, hash: s.orderHash };
}

/// Body for POST /orders, as a browser sends it.
export function body(o: OrderTuple, signature: Hex) {
  return {
    order: {
      salt: o.salt.toString(),
      maker: o.maker,
      marketId: o.marketId.toString(),
      option: o.option,
      isBuy: o.isBuy,
      price: o.price,
      size: o.size.toString(),
      expiration: o.expiration.toString(),
      nonce: o.nonce.toString(),
    },
    signature,
  };
}

/// Signs a fresh order with one of the vectors' test keys under the testnet exchange domain.
export async function signWithKey(keyName: string, o: OrderTuple, exchange: Hex = V.domains.testnet.verifyingContract, chainId = 10143): Promise<Hex> {
  const acct = privateKeyToAccount(V.keys[keyName].privateKey);
  return acct.signTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract: exchange },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: o,
  });
}
