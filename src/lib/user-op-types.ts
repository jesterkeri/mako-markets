// ----------------------------------------------------------------------------
// src/lib/user-op-types.ts
//
// Shared types for ERC-4337 v0.7 user ops. Server-neutral: no env, no
// server-only, no DB. Both browser and server code consume these types.
//
// Two shapes:
//
// `PackedUserOpFields` — the in-memory representation. bigints for all
// numerics. Used at the moment of hashing (SafeOp + userOpHash) and signing.
// This is what the EIP-712 hash math sees.
//
// `StoredSplitFormUserOp` — the persistence + wire representation. Numerics
// are 0x-prefixed lowercase hex so the value can round-trip through Postgres
// jsonb byte-for-byte. Browser ↔ server JSON exchanges and DB rows both use
// this shape; convert to/from `PackedUserOpFields` exactly at the hash/sign
// boundary.
//
// Why two shapes: bigint doesn't survive `JSON.stringify` (throws), so the
// jsonb column can't hold the in-memory form. Hex strings are reversible
// without loss; `viem`'s `hexToBigInt` is the inverse direction.
//
// Naming: "split form" because v0.7 splits paymaster into 4 fields
// (paymaster, paymasterVerificationGasLimit, paymasterPostOpGasLimit,
// paymasterData) — distinct from the legacy "packed" `paymasterAndData` blob.
// The hashing path packs them; the bundler RPC payload uses the split form.
// ----------------------------------------------------------------------------

import { hexToBigInt, toHex, type Address, type Hex } from 'viem';

/// In-memory user op. bigints for numeric fields; hex bytes for the rest.
/// `signature` is intentionally NOT included — the hash computations
/// exclude the signature, and storage handles it separately so we can
/// persist the unsigned op before Magic returns its sig.
export type PackedUserOpFields = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
};

/// Wire / DB representation. All numerics serialized as 0x-prefixed
/// lowercase hex (no `0x00` zero-stripping — readable, round-trip safe).
/// Field set matches `PackedUserOpFields` 1:1.
///
/// Empty-state encoding (Path X / no-paymaster / pre-deployment):
///   - `paymaster = ZERO_ADDRESS`, `paymasterVerificationGasLimit = '0x0'`,
///     `paymasterPostOpGasLimit = '0x0'`, `paymasterData = '0x'` together
///     mean "no paymaster." Hash math collapses these to an empty
///     `paymasterAndData` blob.
///   - `initCode = '0x'` means "Safe is already deployed" (factory +
///     factoryData are not split out at this layer; the initCode blob
///     is the source of truth and `safe-init.ts` produces both forms).
/// All fields stay non-null so the jsonb shape is stable across rows.
export type StoredSplitFormUserOp = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster: Address;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  paymasterData: Hex;
};

/// Lift a `StoredSplitFormUserOp` to the in-memory `PackedUserOpFields`
/// shape (hex numerics → bigints). Used at the hash computation +
/// signing boundary; conversion is lossless because every numeric is a
/// 0x-prefixed hex string of arbitrary length.
///
/// Boundary discipline: this helper does NOT validate the shape of its
/// input. Callers are responsible for ensuring `stored` came from a
/// trusted source. The two trusted sources in 1B:
///   - `aa_pending_user_ops` rows, which are guarded by:
///       1. Drizzle inserts that go through this same `packedToStored`
///          (shape produced by us, never user-supplied).
///       2. Postgres CHECK constraints on `safe_address`, `magic_eoa`,
///          `nonce_hex`, `safe_op_hash`, `user_op_hash`, and `tx_hash`
///          (added in sub-phase C migration) that reject malformed hex.
///   - `buildSponsoredUserOp`'s own return value (already converted via
///     `packedToStored` from in-memory bigints).
/// Anything that arrives over the wire from the browser MUST go through
/// the route layer's zod validation FIRST; do NOT call this helper on
/// browser-supplied JSON without that guard, or `viem.hexToBigInt` will
/// throw at inconsistent points downstream.
export function storedToPacked(stored: StoredSplitFormUserOp): PackedUserOpFields {
  return {
    sender: stored.sender,
    nonce: hexToBigInt(stored.nonce),
    initCode: stored.initCode,
    callData: stored.callData,
    callGasLimit: hexToBigInt(stored.callGasLimit),
    verificationGasLimit: hexToBigInt(stored.verificationGasLimit),
    preVerificationGas: hexToBigInt(stored.preVerificationGas),
    maxFeePerGas: hexToBigInt(stored.maxFeePerGas),
    maxPriorityFeePerGas: hexToBigInt(stored.maxPriorityFeePerGas),
    paymaster: stored.paymaster,
    paymasterVerificationGasLimit: hexToBigInt(stored.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: hexToBigInt(stored.paymasterPostOpGasLimit),
    paymasterData: stored.paymasterData,
  };
}

/// Lower a `PackedUserOpFields` back to `StoredSplitFormUserOp`. Used by
/// the sponsor route when persisting a fresh op to the DB. Every numeric
/// becomes a 0x-prefixed lowercase hex string so the jsonb column has a
/// stable shape across rows.
export function packedToStored(packed: PackedUserOpFields): StoredSplitFormUserOp {
  return {
    sender: packed.sender,
    nonce: toHex(packed.nonce),
    initCode: packed.initCode,
    callData: packed.callData,
    callGasLimit: toHex(packed.callGasLimit),
    verificationGasLimit: toHex(packed.verificationGasLimit),
    preVerificationGas: toHex(packed.preVerificationGas),
    maxFeePerGas: toHex(packed.maxFeePerGas),
    maxPriorityFeePerGas: toHex(packed.maxPriorityFeePerGas),
    paymaster: packed.paymaster,
    paymasterVerificationGasLimit: toHex(packed.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: toHex(packed.paymasterPostOpGasLimit),
    paymasterData: packed.paymasterData,
  };
}
