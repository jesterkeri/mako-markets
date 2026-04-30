// ----------------------------------------------------------------------------
// src/lib/user-op-hash.ts
//
// Compute the EntryPoint v0.7 `userOpHash`. This is the hash the bundler
// returns from `eth_sendUserOperation` and that `eth_getUserOperationReceipt`
// keys off. It is NOT what the user signs (that's the SafeOp hash from
// `safe-op-hash.ts`).
//
// Why we compute it locally even though the bundler returns one:
// `sendSignedUserOp` validates that the bundler's userOpHash matches our
// local computation as a drift guard. If our hash math drifts from the
// EntryPoint's (e.g. on a contract upgrade or a typo on this file), receipt
// lookups would silently fail and we'd never find sent ops on chain.
// Asserting equality at send-time fails loudly instead.
//
// Reference (EntryPoint v0.7):
//   function getUserOpHash(PackedUserOperation userOp) returns (bytes32) {
//     return keccak256(abi.encode(userOp.hash(), address(this), block.chainid));
//   }
//   function hash(PackedUserOperation userOp) returns (bytes32) {
//     return keccak256(encode(userOp));
//   }
//   function encode(PackedUserOperation userOp) returns (bytes) {
//     return abi.encode(
//       userOp.sender, userOp.nonce,
//       keccak256(userOp.initCode), keccak256(userOp.callData),
//       userOp.accountGasLimits, userOp.preVerificationGas, userOp.gasFees,
//       keccak256(userOp.paymasterAndData)
//     );
//   }
//
// Packed bytes32 layouts (high 16 bytes || low 16 bytes):
//   accountGasLimits = pack(verificationGasLimit, callGasLimit)
//   gasFees          = pack(maxPriorityFeePerGas, maxFeePerGas)
//
// initCode is the flat blob `factory (20) || factoryData` for first-op
// deployments, or `0x` if the Safe is already deployed.
//
// paymasterAndData uses the same packing as `safe-op-hash.ts` —
// `paymaster (20) || pmVerGas (16 BE) || pmPostOpGas (16 BE) || pmData`,
// or `0x` when paymaster is the zero address.
//
// Pure. Client-safe. No env, no I/O.
// ----------------------------------------------------------------------------

import {
  encodeAbiParameters,
  keccak256,
  concat,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import { SAFE_CONFIG } from './safe-config';
import { packPaymasterAndData } from './safe-op-hash';
import type { PackedUserOpFields } from './user-op-types';

const ENTRY_POINT_V07: Address = SAFE_CONFIG.entryPoint as Address;

const UINT128_MAX = (1n << 128n) - 1n;

function assertUint128(value: bigint, label: string): void {
  if (value < 0n) throw new Error(`user-op-hash: ${label} is negative`);
  if (value > UINT128_MAX)
    throw new Error(`user-op-hash: ${label} exceeds 2^128 - 1`);
}

/// Pack two uint128 values into a single bytes32 in (high || low) order.
/// Used for both `accountGasLimits` and `gasFees`.
function packUint128Pair(high: bigint, low: bigint): Hex {
  return concat([
    pad(toHex(high), { size: 16 }),
    pad(toHex(low), { size: 16 }),
  ]);
}

/// Compute the EntryPoint v0.7 userOpHash. This is the hash the bundler
/// reports for the user op; it is NOT what the user signs.
export function computeUserOpHash(args: {
  userOp: PackedUserOpFields;
  chainId: number;
}): Hex {
  assertUint128(args.userOp.verificationGasLimit, 'verificationGasLimit');
  assertUint128(args.userOp.callGasLimit, 'callGasLimit');
  assertUint128(args.userOp.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
  assertUint128(args.userOp.maxFeePerGas, 'maxFeePerGas');

  const accountGasLimits = packUint128Pair(
    args.userOp.verificationGasLimit,
    args.userOp.callGasLimit,
  );
  const gasFees = packUint128Pair(
    args.userOp.maxPriorityFeePerGas,
    args.userOp.maxFeePerGas,
  );

  const paymasterAndData = packPaymasterAndData({
    paymaster: args.userOp.paymaster,
    paymasterVerificationGasLimit: args.userOp.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: args.userOp.paymasterPostOpGasLimit,
    paymasterData: args.userOp.paymasterData,
  });

  const innerHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [
        args.userOp.sender,
        args.userOp.nonce,
        keccak256(args.userOp.initCode),
        keccak256(args.userOp.callData),
        accountGasLimits,
        args.userOp.preVerificationGas,
        gasFees,
        keccak256(paymasterAndData),
      ],
    ),
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
      [innerHash, ENTRY_POINT_V07, BigInt(args.chainId)],
    ),
  );
}
