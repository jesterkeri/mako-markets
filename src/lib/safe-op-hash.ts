// ----------------------------------------------------------------------------
// src/lib/safe-op-hash.ts
//
// Compute the Safe4337Module v0.3.0 SafeOp hash. This is the digest the
// Safe owner (Magic EOA) signs over via personal_sign — NOT the EntryPoint
// userOpHash (that's `user-op-hash.ts`, used for receipt lookup only).
//
// EIP-712 domain:
//   keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
//   verifyingContract = Safe4337Module v0.3.0 canonical address
//   (NOT EntryPoint, NOT the Safe itself — `Safe4337Module._domainSeparator()`
//    returns the module's own EIP-712 domain.)
//
// EIP-712 type:
//   SafeOp(
//     address safe, uint256 nonce, bytes initCode, bytes callData,
//     uint128 verificationGasLimit, uint128 callGasLimit, uint256 preVerificationGas,
//     uint128 maxPriorityFeePerGas, uint128 maxFeePerGas, bytes paymasterAndData,
//     uint48 validAfter, uint48 validUntil, address entryPoint
//   )
//
// Field order matches the v0.3.0 module exactly. The `verificationGasLimit`
// / `callGasLimit` order at the type level is inverted from the
// PackedUserOperation accountGasLimits packing (which is verGas FIRST then
// callGas SECOND in the packed bytes32). That is INTENTIONAL on the
// module's side — the EIP-712 typehash field order is the source of truth
// here, and the packing order is a separate convention used inside the
// EntryPoint userOpHash math (see `user-op-hash.ts`).
//
// `paymasterAndData` is the legacy v0.6 packed form:
//   paymaster (20) || pmVerificationGasLimit (16 BE) || pmPostOpGasLimit (16 BE) || pmData
// Empty paymaster (paymaster == 0x000…0) packs as `0x` per the convention
// in the EntryPoint v0.7 reference; callers MUST pass `paymaster=0`,
// `paymasterVerificationGasLimit=0`, `paymasterPostOpGasLimit=0`,
// `paymasterData=0x` to indicate "no paymaster" — the helper detects this
// shape and emits an empty paymasterAndData.
//
// Reference: this file's math is byte-for-byte ported from the verified
// `scripts/probe-pimlico.mts` `computeSafeOpHash`, which has been proven
// against a live Pimlico-on-Monad bundler in Phase 1B prereq #4.
//
// Pure. Client-safe. No env, no I/O.
// ----------------------------------------------------------------------------

import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  concat,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import { SAFE_CONFIG } from './safe-config';
import type { PackedUserOpFields } from './user-op-types';

const ENTRY_POINT_V07: Address = SAFE_CONFIG.entryPoint as Address;
const SAFE_4337_MODULE_V030: Address = SAFE_CONFIG.module4337 as Address;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const SAFE_OP_TYPE_STRING =
  'SafeOp(address safe,uint256 nonce,bytes initCode,bytes callData,' +
  'uint128 verificationGasLimit,uint128 callGasLimit,uint256 preVerificationGas,' +
  'uint128 maxPriorityFeePerGas,uint128 maxFeePerGas,bytes paymasterAndData,' +
  'uint48 validAfter,uint48 validUntil,address entryPoint)';

const EIP712_DOMAIN_TYPE_STRING =
  'EIP712Domain(uint256 chainId,address verifyingContract)';

const SAFE_OP_TYPEHASH = keccak256(
  new TextEncoder().encode(SAFE_OP_TYPE_STRING),
);
const EIP712_DOMAIN_TYPEHASH = keccak256(
  new TextEncoder().encode(EIP712_DOMAIN_TYPE_STRING),
);

const UINT48_MAX = 0xFFFFFFFFFFFFn;

function assertUint48(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`safe-op-hash: ${label} is negative`);
  if (value > UINT48_MAX)
    throw new Error(`safe-op-hash: ${label} exceeds 2^48 - 1`);
}

/// Pack v0.7 paymaster split fields into the legacy on-chain
/// `paymasterAndData` blob. When the paymaster slot is the zero address
/// (no paymaster), returns `0x` — Safe4337Module's hash math hashes the
/// empty bytes in that case. Callers MUST set every paymaster numeric to
/// zero when paymaster is unset; mixed states (zero address + non-zero
/// gas limit) throw.
export function packPaymasterAndData(args: {
  paymaster: Address;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  paymasterData: Hex;
}): Hex {
  if (args.paymaster.toLowerCase() === ZERO_ADDRESS) {
    if (
      args.paymasterVerificationGasLimit !== 0n ||
      args.paymasterPostOpGasLimit !== 0n ||
      args.paymasterData !== '0x'
    ) {
      throw new Error(
        'safe-op-hash: paymaster is zero address but other paymaster ' +
          'fields are non-empty (mixed state)',
      );
    }
    return '0x';
  }
  return concat([
    args.paymaster,
    pad(toHex(args.paymasterVerificationGasLimit), { size: 16 }),
    pad(toHex(args.paymasterPostOpGasLimit), { size: 16 }),
    args.paymasterData,
  ]);
}

/// Compute the SafeOp hash. This is the 32-byte digest the user (Magic
/// EOA) signs to authorize the user op.
export function computeSafeOpHash(args: {
  userOp: PackedUserOpFields;
  validAfter: bigint;
  validUntil: bigint;
  chainId: number;
}): Hex {
  assertUint48(args.validAfter, 'validAfter');
  assertUint48(args.validUntil, 'validUntil');

  const paymasterAndData = packPaymasterAndData({
    paymaster: args.userOp.paymaster,
    paymasterVerificationGasLimit: args.userOp.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: args.userOp.paymasterPostOpGasLimit,
    paymasterData: args.userOp.paymasterData,
  });

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'uint256' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'bytes32' },
        { type: 'uint48' },
        { type: 'uint48' },
        { type: 'address' },
      ],
      [
        SAFE_OP_TYPEHASH,
        args.userOp.sender,
        args.userOp.nonce,
        keccak256(args.userOp.initCode),
        keccak256(args.userOp.callData),
        args.userOp.verificationGasLimit,
        args.userOp.callGasLimit,
        args.userOp.preVerificationGas,
        args.userOp.maxPriorityFeePerGas,
        args.userOp.maxFeePerGas,
        keccak256(paymasterAndData),
        Number(args.validAfter),
        Number(args.validUntil),
        ENTRY_POINT_V07,
      ],
    ),
  );

  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [EIP712_DOMAIN_TYPEHASH, BigInt(args.chainId), SAFE_4337_MODULE_V030],
    ),
  );

  return keccak256(
    encodePacked(
      ['bytes2', 'bytes32', 'bytes32'],
      ['0x1901', domainSeparator, structHash],
    ),
  );
}
