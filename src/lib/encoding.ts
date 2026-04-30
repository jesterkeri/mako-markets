// ----------------------------------------------------------------------------
// src/lib/encoding.ts
//
// Low-level byte-encoding helpers for the ERC-4337 / Safe4337Module signing
// path. Stays narrow on purpose — no viem types beyond the `Hex` brand, no
// Pimlico knowledge, no Safe knowledge. Just pure byte math with assertions.
// ----------------------------------------------------------------------------

import { pad, toHex, type Hex } from 'viem';

const UINT48_MAX = 0xFFFFFFFFFFFFn;

/**
 * Big-endian 6-byte (uint48) hex encoding with overflow + sign assertions.
 *
 * Used by the SafeOp signing path: a 4337 user op's signature carries a 12-byte
 * validity-window prefix (`validAfter (6 BE) || validUntil (6 BE)`) ahead of
 * the 65-byte ECDSA signature. Big-endian byte order matters — Safe4337Module
 * recomputes the same packing on chain and compares byte-for-byte; little-
 * endian or zero-padded-the-wrong-side would surface as an opaque AA24
 * "signature error" with no useful diagnostic.
 *
 * Asserts on overflow (> 2^48 - 1) and negatives so a future bug at the
 * caller site fails loud at the right spot rather than silently truncating
 * bits and producing a signature that doesn't recover.
 */
export function uint48ToBytes6BE(value: bigint): Hex {
  if (value < 0n) throw new Error('uint48ToBytes6BE: negative value');
  if (value > UINT48_MAX)
    throw new Error('uint48ToBytes6BE: value exceeds 2^48 - 1');
  return pad(toHex(value), { size: 6 }) as Hex;
}
