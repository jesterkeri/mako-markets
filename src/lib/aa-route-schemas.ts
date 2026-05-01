import { z } from 'zod';

// ----------------------------------------------------------------------------
// src/lib/aa-route-schemas.ts
//
// Zod request/response shapes for /api/aa/sponsor + /api/aa/send. Strings
// are constrained to lowercase 0x-hex regexes so we never have to re-
// validate downstream — by the time the route handler is past `safeParse`,
// every hex field is known well-formed.
//
// `Hex77` covers the SafeOp `eth_sign_envelope` shape: 12 bytes validity
// prefix + 65 bytes ECDSA signature = 77 bytes = 154 hex chars + `0x`.
// `HexBigint` is `0x` + 1+ hex digits (no length cap) so we can carry
// uint256 values over the wire without lossy `Number` round-tripping.
// ----------------------------------------------------------------------------

const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Hex77 = z.string().regex(/^0x[0-9a-fA-F]{154}$/);
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const HexBigint = z.string().regex(/^0x[0-9a-fA-F]+$/);
const HexBytes = z.string().regex(/^0x[0-9a-fA-F]*$/);

import { MONAD_TESTNET_ID } from './chain';

export const SponsorRequest = z.object({
  chainId: z.literal(MONAD_TESTNET_ID),
  call: z.object({
    to: Address,
    /// Browser sends value as 0x-hex; the route converts to bigint via
    /// viem's `hexToBigInt` before the allowlist + lib calls.
    value: HexBigint,
    data: HexBytes,
  }),
});

export type SponsorRequest = z.infer<typeof SponsorRequest>;

export const SendRequest = z.object({
  pendingUserOpId: z.string().uuid(),
  /// 77-byte SafeOp `eth_sign_envelope` — validity prefix + ECDSA sig.
  signature: Hex77,
});

export type SendRequest = z.infer<typeof SendRequest>;

// Re-export the primitives in case downstream tests need them.
export { Hex32, Hex77, Address, HexBigint, HexBytes };
