// ----------------------------------------------------------------------------
// src/lib/__tests__/user-op-hash.test.ts
//
// Coverage:
//   - Returns 32-byte hex digest.
//   - Determinism: same input → same hash twice.
//   - Sensitivity: every input field changes the hash.
//   - uint128 overflow + negative checks fire on each gas/fee field.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';

import { type Address, type Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';

import { computeUserOpHash } from '../user-op-hash';
import { SAFE_CONFIG } from '../safe-config';
import type { PackedUserOpFields } from '../user-op-types';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ENTRY_POINT_V07 = SAFE_CONFIG.entryPoint as Address;
const CHAIN_ID = 10143;
const UINT128_MAX = (1n << 128n) - 1n;

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

describe('computeUserOpHash', () => {
  it('returns a 32-byte hex digest', () => {
    const h = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const h1 = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });
    const h2 = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });
    expect(h1).toBe(h2);
  });

  it('changes when chainId changes', () => {
    const h1 = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });
    const h2 = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID + 1 });
    expect(h1).not.toBe(h2);
  });

  // ── viem cross-check (independent fixture) ───────────────────────────────
  // viem's `getUserOperationHash` is an independent EntryPoint v0.7 packer.
  // It walks the same PackedUserOperation layout (accountGasLimits high/low
  // packing, gasFees high/low packing, paymasterAndData concat) but through
  // its own code path. If our high/low packing direction were inverted, or
  // if the inner→outer keccak nesting drifted, these would diverge.
  describe('viem cross-check (independent EntryPoint v0.7 packer)', () => {
    function viemHashFor(
      op: PackedUserOpFields,
      chainId: number,
    ): `0x${string}` {
      // viem's split-form 0.7 UserOperation: paymaster fields are split,
      // factory + factoryData are split. For an op with empty paymaster
      // (zero address + all-zero gas) and empty initCode, omit those
      // fields entirely — viem's hash collapses them to empty bytes.
      const hasPaymaster = op.paymaster.toLowerCase() !== ZERO_ADDRESS;
      const hasInitCode = op.initCode !== '0x';

      // initCode = factory (20) || factoryData. Split for viem's API.
      let factory: Address | undefined;
      let factoryData: Hex | undefined;
      if (hasInitCode) {
        const ic = op.initCode.toLowerCase();
        factory = ('0x' + ic.slice(2, 2 + 40)) as Address;
        factoryData = ('0x' + ic.slice(2 + 40)) as Hex;
      }

      return getUserOperationHash({
        chainId,
        entryPointAddress: ENTRY_POINT_V07,
        entryPointVersion: '0.7',
        userOperation: {
          sender: op.sender,
          nonce: op.nonce,
          callData: op.callData,
          callGasLimit: op.callGasLimit,
          verificationGasLimit: op.verificationGasLimit,
          preVerificationGas: op.preVerificationGas,
          maxFeePerGas: op.maxFeePerGas,
          maxPriorityFeePerGas: op.maxPriorityFeePerGas,
          signature: '0x',
          ...(hasPaymaster
            ? {
                paymaster: op.paymaster,
                paymasterVerificationGasLimit:
                  op.paymasterVerificationGasLimit,
                paymasterPostOpGasLimit: op.paymasterPostOpGasLimit,
                paymasterData: op.paymasterData,
              }
            : {}),
          ...(hasInitCode
            ? { factory: factory!, factoryData: factoryData! }
            : {}),
        },
      });
    }

    it('matches viem on the empty-paymaster, no-initCode base case', () => {
      const ours = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });
      const viem = viemHashFor(baseUserOp, CHAIN_ID);
      expect(ours).toBe(viem);
    });

    it('matches viem with a non-zero initCode', () => {
      const userOp: PackedUserOpFields = {
        ...baseUserOp,
        initCode:
          ('0x' + 'aa'.repeat(20) + 'deadbeef') as Hex, // 20-byte factory + 4 bytes
      };
      const ours = computeUserOpHash({ userOp, chainId: CHAIN_ID });
      const viem = viemHashFor(userOp, CHAIN_ID);
      expect(ours).toBe(viem);
    });

    it('matches viem with a populated paymaster', () => {
      const userOp: PackedUserOpFields = {
        ...baseUserOp,
        paymaster: ('0x' + 'cc'.repeat(20)) as Address,
        paymasterVerificationGasLimit: 80_000n,
        paymasterPostOpGasLimit: 40_000n,
        paymasterData: '0xaabbcc',
      };
      const ours = computeUserOpHash({ userOp, chainId: CHAIN_ID });
      const viem = viemHashFor(userOp, CHAIN_ID);
      expect(ours).toBe(viem);
    });

    it('matches viem with non-trivial gas + fee values', () => {
      const userOp: PackedUserOpFields = {
        ...baseUserOp,
        callGasLimit: 0x1234567890n,
        verificationGasLimit: 0x9876543210n,
        preVerificationGas: 0xabcdef0123n,
        maxFeePerGas: 0xdeadbeef00n,
        maxPriorityFeePerGas: 0xbeefcafe11n,
      };
      const ours = computeUserOpHash({ userOp, chainId: CHAIN_ID });
      const viem = viemHashFor(userOp, CHAIN_ID);
      expect(ours).toBe(viem);
    });
  });

  describe('sensitivity — every field shifts the hash', () => {
    const base = computeUserOpHash({ userOp: baseUserOp, chainId: CHAIN_ID });

    const cases: Array<[string, () => Hex]> = [
      [
        'sender',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, sender: '0x2222222222222222222222222222222222222222' },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'nonce',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, nonce: 1n },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'initCode',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, initCode: '0xaa' },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'callData',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, callData: '0xfeedbeef' },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'callGasLimit',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, callGasLimit: 99_999n },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'verificationGasLimit',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, verificationGasLimit: 199_999n },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'preVerificationGas',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, preVerificationGas: 49_999n },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'maxFeePerGas',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, maxFeePerGas: 999_999_999n },
            chainId: CHAIN_ID,
          }),
      ],
      [
        'maxPriorityFeePerGas',
        () =>
          computeUserOpHash({
            userOp: { ...baseUserOp, maxPriorityFeePerGas: 999_999_999n },
            chainId: CHAIN_ID,
          }),
      ],
    ];
    for (const [label, mutate] of cases) {
      it(`mutating ${label} changes the hash`, () => {
        expect(mutate()).not.toBe(base);
      });
    }
  });

  // ── per-paymaster-subfield sensitivity ──────────────────────────────────
  // Bundle each paymaster subfield individually. If a future edit
  // accidentally drops one subfield from `packPaymasterAndData` (e.g.,
  // omitting paymasterPostOpGasLimit from the concat), the corresponding
  // case here flips green.
  describe('paymaster subfield sensitivity', () => {
    const populated: PackedUserOpFields = {
      ...baseUserOp,
      paymaster: ('0x' + 'cc'.repeat(20)) as Address,
      paymasterVerificationGasLimit: 80_000n,
      paymasterPostOpGasLimit: 40_000n,
      paymasterData: '0xaabbcc',
    };
    const baseHash = computeUserOpHash({
      userOp: populated,
      chainId: CHAIN_ID,
    });

    it('mutating paymaster address changes the hash', () => {
      const h = computeUserOpHash({
        userOp: { ...populated, paymaster: ('0x' + 'dd'.repeat(20)) as Address },
        chainId: CHAIN_ID,
      });
      expect(h).not.toBe(baseHash);
    });
    it('mutating paymasterVerificationGasLimit changes the hash', () => {
      const h = computeUserOpHash({
        userOp: { ...populated, paymasterVerificationGasLimit: 80_001n },
        chainId: CHAIN_ID,
      });
      expect(h).not.toBe(baseHash);
    });
    it('mutating paymasterPostOpGasLimit changes the hash', () => {
      const h = computeUserOpHash({
        userOp: { ...populated, paymasterPostOpGasLimit: 40_001n },
        chainId: CHAIN_ID,
      });
      expect(h).not.toBe(baseHash);
    });
    it('mutating paymasterData changes the hash', () => {
      const h = computeUserOpHash({
        userOp: { ...populated, paymasterData: '0xaabbcd' },
        chainId: CHAIN_ID,
      });
      expect(h).not.toBe(baseHash);
    });
  });

  describe('uint128 range checks', () => {
    const overflowCases: Array<[string, Partial<PackedUserOpFields>]> = [
      ['verificationGasLimit', { verificationGasLimit: UINT128_MAX + 1n }],
      ['callGasLimit', { callGasLimit: UINT128_MAX + 1n }],
      ['maxPriorityFeePerGas', { maxPriorityFeePerGas: UINT128_MAX + 1n }],
      ['maxFeePerGas', { maxFeePerGas: UINT128_MAX + 1n }],
    ];
    for (const [label, override] of overflowCases) {
      it(`throws on ${label} > 2^128 - 1`, () => {
        expect(() =>
          computeUserOpHash({
            userOp: { ...baseUserOp, ...override },
            chainId: CHAIN_ID,
          }),
        ).toThrow(new RegExp(label));
      });
    }

    const negativeCases: Array<[string, Partial<PackedUserOpFields>]> = [
      ['verificationGasLimit', { verificationGasLimit: -1n }],
      ['callGasLimit', { callGasLimit: -1n }],
      ['maxPriorityFeePerGas', { maxPriorityFeePerGas: -1n }],
      ['maxFeePerGas', { maxFeePerGas: -1n }],
    ];
    for (const [label, override] of negativeCases) {
      it(`throws on negative ${label}`, () => {
        expect(() =>
          computeUserOpHash({
            userOp: { ...baseUserOp, ...override },
            chainId: CHAIN_ID,
          }),
        ).toThrow(new RegExp(label));
      });
    }
  });

  it('accepts UINT128_MAX at the boundary', () => {
    expect(() =>
      computeUserOpHash({
        userOp: { ...baseUserOp, callGasLimit: UINT128_MAX },
        chainId: CHAIN_ID,
      }),
    ).not.toThrow();
  });
});
