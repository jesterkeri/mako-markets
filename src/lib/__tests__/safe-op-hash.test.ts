// ----------------------------------------------------------------------------
// src/lib/__tests__/safe-op-hash.test.ts
//
// Coverage:
//   - Hash result is 32 bytes (66-char 0x-prefixed hex).
//   - Determinism: same input → same hash (called twice).
//   - Cross-check vs viem's hashTypedData using the SafeOp EIP-712 type.
//     This is an independent code path and proves our manual encoding's
//     field order, type widths, and `bytes` keccak256 wrapping match
//     EIP-712 conventions.
//   - Sensitivity: changing each input field changes the hash.
//   - packPaymasterAndData: empty-paymaster path returns 0x; mixed-state
//     inputs throw; populated path produces the expected layout.
//   - validAfter / validUntil range checks fire on overflow + negative.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import { hashTypedData, type Address, type Hex } from 'viem';

import {
  computeSafeOpHash,
  packPaymasterAndData,
} from '../safe-op-hash';
import { SAFE_CONFIG } from '../safe-config';
import type { PackedUserOpFields } from '../user-op-types';

const SAFE_4337_MODULE_V030 = SAFE_CONFIG.module4337 as Address;
const ENTRY_POINT_V07 = SAFE_CONFIG.entryPoint as Address;

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

const CHAIN_ID = 10143;

const baseUserOp: PackedUserOpFields = {
  sender: '0x1111111111111111111111111111111111111111',
  nonce: 0n,
  initCode: '0x',
  callData: '0xdeadbeef',
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: 1_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymaster: ZERO_ADDRESS,
  paymasterVerificationGasLimit: 0n,
  paymasterPostOpGasLimit: 0n,
  paymasterData: '0x',
};

describe('packPaymasterAndData', () => {
  it('returns 0x when paymaster is zero address with all-zero numerics', () => {
    expect(
      packPaymasterAndData({
        paymaster: ZERO_ADDRESS,
        paymasterVerificationGasLimit: 0n,
        paymasterPostOpGasLimit: 0n,
        paymasterData: '0x',
      }),
    ).toBe('0x');
  });

  it('rejects zero paymaster with non-zero verification gas', () => {
    expect(() =>
      packPaymasterAndData({
        paymaster: ZERO_ADDRESS,
        paymasterVerificationGasLimit: 1n,
        paymasterPostOpGasLimit: 0n,
        paymasterData: '0x',
      }),
    ).toThrow(/mixed state/);
  });

  it('rejects zero paymaster with non-empty paymasterData', () => {
    expect(() =>
      packPaymasterAndData({
        paymaster: ZERO_ADDRESS,
        paymasterVerificationGasLimit: 0n,
        paymasterPostOpGasLimit: 0n,
        paymasterData: '0xaa',
      }),
    ).toThrow(/mixed state/);
  });

  it('packs populated fields as 20 + 16 + 16 + data bytes', () => {
    const packed = packPaymasterAndData({
      paymaster: '0x' + 'cc'.repeat(20) as Address,
      paymasterVerificationGasLimit: 0x1234n,
      paymasterPostOpGasLimit: 0x5678n,
      paymasterData: '0xaabb',
    });
    // 20 (paymaster) + 16 (verGas BE pad) + 16 (postGas BE pad) + 2 (data) = 54 bytes
    expect(packed.length).toBe(2 + 54 * 2);
    // First 20 bytes: paymaster
    expect(packed.slice(2, 2 + 20 * 2)).toBe('cc'.repeat(20));
    // Next 16 bytes: verGas big-endian = 000…001234
    expect(packed.slice(2 + 20 * 2, 2 + 36 * 2)).toBe(
      '00'.repeat(14) + '1234',
    );
    // Next 16 bytes: postGas big-endian = 000…005678
    expect(packed.slice(2 + 36 * 2, 2 + 52 * 2)).toBe(
      '00'.repeat(14) + '5678',
    );
    // Trailing data
    expect(packed.slice(2 + 52 * 2)).toBe('aabb');
  });
});

describe('computeSafeOpHash', () => {
  it('returns a 32-byte hex digest', () => {
    const h = computeSafeOpHash({
      userOp: baseUserOp,
      validAfter: 0n,
      validUntil: 0xffffffffffffn,
      chainId: CHAIN_ID,
    });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = computeSafeOpHash({
      userOp: baseUserOp,
      validAfter: 0n,
      validUntil: 0xffffffffffffn,
      chainId: CHAIN_ID,
    });
    const h2 = computeSafeOpHash({
      userOp: baseUserOp,
      validAfter: 0n,
      validUntil: 0xffffffffffffn,
      chainId: CHAIN_ID,
    });
    expect(h1).toBe(h2);
  });

  it('matches viem.hashTypedData using the SafeOp EIP-712 type', () => {
    // Independent path: viem's typed-data hasher walks an EIP-712 schema
    // separately from our manual encodeAbiParameters chain. If field order,
    // type widths, or the embedded keccak256 wrapping for bytes fields
    // drift, the two hashes diverge.
    const ours = computeSafeOpHash({
      userOp: baseUserOp,
      validAfter: 0n,
      validUntil: 0xffffffffffffn,
      chainId: CHAIN_ID,
    });

    const viemHash = hashTypedData({
      domain: {
        chainId: CHAIN_ID,
        verifyingContract: SAFE_4337_MODULE_V030,
      },
      types: {
        SafeOp: [
          { name: 'safe', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'verificationGasLimit', type: 'uint128' },
          { name: 'callGasLimit', type: 'uint128' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'maxPriorityFeePerGas', type: 'uint128' },
          { name: 'maxFeePerGas', type: 'uint128' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'entryPoint', type: 'address' },
        ],
      },
      primaryType: 'SafeOp',
      message: {
        safe: baseUserOp.sender,
        nonce: baseUserOp.nonce,
        initCode: baseUserOp.initCode,
        callData: baseUserOp.callData,
        verificationGasLimit: baseUserOp.verificationGasLimit,
        callGasLimit: baseUserOp.callGasLimit,
        preVerificationGas: baseUserOp.preVerificationGas,
        maxPriorityFeePerGas: baseUserOp.maxPriorityFeePerGas,
        maxFeePerGas: baseUserOp.maxFeePerGas,
        paymasterAndData: '0x' as Hex, // empty paymaster → empty bytes
        validAfter: 0,
        validUntil: 0xffffffffffff,
        entryPoint: ENTRY_POINT_V07,
      },
    });

    expect(ours).toBe(viemHash);
  });

  it('cross-check holds with a populated paymaster', () => {
    const userOp: PackedUserOpFields = {
      ...baseUserOp,
      paymaster: '0x' + 'cc'.repeat(20) as Address,
      paymasterVerificationGasLimit: 80_000n,
      paymasterPostOpGasLimit: 40_000n,
      paymasterData: '0xaabbcc',
    };
    const ours = computeSafeOpHash({
      userOp,
      validAfter: 100n,
      validUntil: 200n,
      chainId: CHAIN_ID,
    });

    const paymasterAndData = packPaymasterAndData({
      paymaster: userOp.paymaster,
      paymasterVerificationGasLimit: userOp.paymasterVerificationGasLimit,
      paymasterPostOpGasLimit: userOp.paymasterPostOpGasLimit,
      paymasterData: userOp.paymasterData,
    });

    const viemHash = hashTypedData({
      domain: {
        chainId: CHAIN_ID,
        verifyingContract: SAFE_4337_MODULE_V030,
      },
      types: {
        SafeOp: [
          { name: 'safe', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'initCode', type: 'bytes' },
          { name: 'callData', type: 'bytes' },
          { name: 'verificationGasLimit', type: 'uint128' },
          { name: 'callGasLimit', type: 'uint128' },
          { name: 'preVerificationGas', type: 'uint256' },
          { name: 'maxPriorityFeePerGas', type: 'uint128' },
          { name: 'maxFeePerGas', type: 'uint128' },
          { name: 'paymasterAndData', type: 'bytes' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'entryPoint', type: 'address' },
        ],
      },
      primaryType: 'SafeOp',
      message: {
        safe: userOp.sender,
        nonce: userOp.nonce,
        initCode: userOp.initCode,
        callData: userOp.callData,
        verificationGasLimit: userOp.verificationGasLimit,
        callGasLimit: userOp.callGasLimit,
        preVerificationGas: userOp.preVerificationGas,
        maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
        maxFeePerGas: userOp.maxFeePerGas,
        paymasterAndData,
        validAfter: 100,
        validUntil: 200,
        entryPoint: ENTRY_POINT_V07,
      },
    });

    expect(ours).toBe(viemHash);
  });

  describe('sensitivity — every field shifts the hash', () => {
    const base = computeSafeOpHash({
      userOp: baseUserOp,
      validAfter: 0n,
      validUntil: 0n,
      chainId: CHAIN_ID,
    });

    const cases: Array<[string, () => Hex]> = [
      [
        'sender',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, sender: '0x2222222222222222222222222222222222222222' },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'nonce',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, nonce: 1n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'initCode',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, initCode: '0xaa' },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'callData',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, callData: '0xfeedbeef' },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'callGasLimit',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, callGasLimit: 99_999n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'verificationGasLimit',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, verificationGasLimit: 199_999n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'preVerificationGas',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, preVerificationGas: 49_999n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'maxFeePerGas',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, maxFeePerGas: 999_999_999n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'maxPriorityFeePerGas',
        () =>
          computeSafeOpHash({
            userOp: { ...baseUserOp, maxPriorityFeePerGas: 999_999_999n },
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'validAfter',
        () =>
          computeSafeOpHash({
            userOp: baseUserOp,
            validAfter: 1n,
            validUntil: 0n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'validUntil',
        () =>
          computeSafeOpHash({
            userOp: baseUserOp,
            validAfter: 0n,
            validUntil: 1n,
            chainId: CHAIN_ID,
          }),
      ],
      [
        'chainId',
        () =>
          computeSafeOpHash({
            userOp: baseUserOp,
            validAfter: 0n,
            validUntil: 0n,
            chainId: CHAIN_ID + 1,
          }),
      ],
    ];
    for (const [label, mutate] of cases) {
      it(`mutating ${label} changes the hash`, () => {
        expect(mutate()).not.toBe(base);
      });
    }
  });

  it('throws on validAfter > 2^48 - 1', () => {
    expect(() =>
      computeSafeOpHash({
        userOp: baseUserOp,
        validAfter: 0x1000000000000n,
        validUntil: 0n,
        chainId: CHAIN_ID,
      }),
    ).toThrow(/validAfter/);
  });

  it('throws on negative validUntil', () => {
    expect(() =>
      computeSafeOpHash({
        userOp: baseUserOp,
        validAfter: 0n,
        validUntil: -1n,
        chainId: CHAIN_ID,
      }),
    ).toThrow(/validUntil/);
  });
});
