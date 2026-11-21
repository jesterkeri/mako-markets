// The order model: plan 4.1 typed data, the order hash, strict local recovery, and the strict parse of an order
// sent by a browser.
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import type { OrderTuple } from './abi';

export const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'marketId', type: 'uint256' },
    { name: 'option', type: 'uint8' },
    { name: 'isBuy', type: 'bool' },
    { name: 'price', type: 'uint8' },
    { name: 'size', type: 'uint128' },
    { name: 'expiration', type: 'uint64' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const DOMAIN_NAME = 'Mako Market Exchange';
export const DOMAIN_VERSION = '1';

export interface DomainCfg {
  chainId: number;
  exchange: Hex;
}

export function orderHash(o: OrderTuple, d: DomainCfg): Hex {
  return hashTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: d.chainId, verifyingContract: d.exchange },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: o,
  });
}

const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const U256 = (1n << 256n) - 1n;
const CANON = /^(0|[1-9][0-9]*)$/;

/// A canonical decimal (no sign, no leading zeros, no spaces) inside [0, max], or null.
export function canonicalUint(v: unknown, max: bigint): bigint | null {
  if (typeof v !== 'string' || !CANON.test(v) || v.length > 78) return null;
  const n = BigInt(v);
  return n <= max ? n : null;
}

export type ParsedOrder = { ok: true; order: OrderTuple; signature: Hex } | { ok: false };

/// Strict shape of the POST body: `{ order: { salt, maker, marketId, option, isBuy, price, size, expiration, nonce },
/// signature }`. Large integers are canonical decimal strings; `option` and `price` are JSON integers. Any other
/// shape is refused. Value limits (price 1 to 99, lot size, and so on) are intake's, not the parser's.
export function parseOrderBody(body: unknown): ParsedOrder {
  const bad: ParsedOrder = { ok: false };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad;
  const b = body as Record<string, unknown>;
  if (typeof b.signature !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(b.signature)) return bad;
  const o = b.order;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return bad;
  const f = o as Record<string, unknown>;
  const maker = f.maker;
  if (typeof maker !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(maker)) return bad;
  const salt = canonicalUint(f.salt, U256);
  const marketId = canonicalUint(f.marketId, U256);
  const size = canonicalUint(f.size, U128);
  const expiration = canonicalUint(f.expiration, U64);
  const nonce = canonicalUint(f.nonce, U64);
  if (salt === null || marketId === null || size === null || expiration === null || nonce === null) return bad;
  const option = f.option;
  const price = f.price;
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option > 255) return bad;
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 0 || price > 255) return bad;
  if (typeof f.isBuy !== 'boolean') return bad;
  return {
    ok: true,
    signature: b.signature.toLowerCase() as Hex,
    order: { salt, maker: maker.toLowerCase() as Hex, marketId, option, isBuy: f.isBuy, price, size, expiration, nonce },
  };
}

/// secp256k1 half order, as OpenZeppelin's ECDSA uses: a signature with s above it is malleable and refused.
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/// Local recovery with exactly the contract's step-1 rules (plan 4.6; OpenZeppelin `ECDSA.tryRecover`): 65 bytes,
/// `s` in the lower half, `v` 27 or 28, and a non-zero recovered address. viem's own recovery is more lenient (it
/// recovers from a high-s twin and from `v` 0 or 1), so it is only called after these checks pass.
export async function recoverStrict(hash: Hex, signature: Hex): Promise<Hex | null> {
  if (signature.length !== 2 + 65 * 2) return null;
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) return null;
  const sn = BigInt(s);
  if (sn === 0n || sn > HALF_N || BigInt(r) === 0n) return null;
  try {
    const addr = await recoverAddress({ hash, signature: { r, s, v: BigInt(v) } });
    return /^0x0{40}$/i.test(addr) ? null : (addr.toLowerCase() as Hex);
  } catch {
    return null;
  }
}

/// The Safe personal-message form the Mako app signs (plan 4.2, 4.6): 65 bytes with `v` 31 or 32 (the signer's v plus 4).
export function isSafeFormSignature(signature: Hex): boolean {
  if (signature.length !== 2 + 65 * 2) return false;
  const v = parseInt(signature.slice(130, 132), 16);
  return v === 31 || v === 32;
}
