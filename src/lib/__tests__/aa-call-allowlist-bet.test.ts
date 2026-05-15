// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-bet.test.ts
//
// Phase 1D bet-flow allowlist test matrix. Three describe blocks, one per
// validator (plan v4 round-3 MINOR 2 fix — sponsor-time tuple validation
// and send-time wrapper validation are different surfaces with different
// inputs; the test matrix MUST mirror that split).
//
//   describe('assertBetSingleCall', ...)
//     Sponsor-time, single placeBet call. Validates target=MAKO,
//     value=0n, decode succeeds, amount > 0n.
//
//   describe('assertBetBatchedCalls', ...)
//     Sponsor-time, raw two-call tuple. Validates [approve, placeBet].
//     Does NOT see MultiSend bytes — that's the wrapper's job, built
//     downstream by buildSponsoredUserOp.
//
//   describe('assertSponsoredCallData (extended for batched)', ...)
//     Send-time, decodes the persisted wrapper. Single-call wrappers
//     route to the smoke / bet_single inner-call invariants. Batched
//     wrappers (op=1, to=MultiSendCallOnly) parse MultiSend bytes and
//     validate inner sub-calls.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem';

import {
  assertBetBatchedCalls,
  assertBetSingleCall,
  assertSponsoredCallData,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { SAFE_CONFIG } from '../safe-config';
import { USDC_ADDRESS } from '../usdc';
import { encodeMultiSendBytes as libEncodeMultiSendBytes } from '../user-op';
import {
  buildBadOuterArgsWrapper,
  buildPreFixRawWrapper,
  buildWrappedMultiSendWrapper,
  encodeBatchedExecuteUserOpCallData,
} from './aa-test-helpers';

const MAX_UINT_256 = (1n << 256n) - 1n;
const SAFE: Address = '0x1111111111111111111111111111111111111111';
const NON_MAKO: Address = '0x4444444444444444444444444444444444444444';
const NON_USDC: Address = '0x5555555555555555555555555555555555555555';

const APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const PLACEBET_ABI = [
  {
    type: 'function',
    name: 'placeBet',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'isYes', type: 'bool' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const SAFE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

function encodePlaceBet(id: bigint, isYes: boolean, amount: bigint): Hex {
  return encodeFunctionData({
    abi: PLACEBET_ABI,
    functionName: 'placeBet',
    args: [id, isYes, amount],
  });
}

/// Encode a Safe MultiSend tuple per the on-chain format:
///   op(1) || to(20) || value(32) || dataLen(32) || data(dataLen)
///
/// This local helper exists ONLY for the "negative" tests where we need
/// to inject `op !== 0` (delegatecall in inner sub-call) — the lib's
/// production encoder hardcodes `op = 0` because MultiSendCallOnly
/// rejects op=1 internally. For all valid (op=0) cases the tests use
/// the production encoder directly via `encodeMultiSendBytes` (round-1
/// MINOR 1 fix — single source of truth for the encoder format).
function encodeMultiSendTupleAllowingNonZeroOp(args: {
  op: number;
  to: Address;
  value: bigint;
  data: Hex;
}): Hex {
  const dataBytes = (args.data.startsWith('0x')
    ? args.data.slice(2)
    : args.data) as string;
  const dataLen = BigInt(dataBytes.length / 2);
  return concat([
    toHex(args.op, { size: 1 }),
    args.to,
    pad(toHex(args.value), { size: 32 }),
    pad(toHex(dataLen), { size: 32 }),
    args.data,
  ]) as Hex;
}

/// Wrap the lib's production `encodeMultiSendBytes` for tests that need
/// to encode a [approve, placeBet] tuple. Production output flows
/// through this function path.
function encodeMultiSendBytes(
  tuples: ReadonlyArray<{
    op: number;
    to: Address;
    value: bigint;
    data: Hex;
  }>,
): Hex {
  // Production encoder hardcodes op=0. For valid-shape tests we expect
  // every input to have op=0; assert defensively + delegate to the lib.
  // Tests that need op!=0 use `encodeMultiSendTupleAllowingNonZeroOp`
  // directly + concat to compose bytes that mimic a malicious payload.
  for (const t of tuples) {
    if (t.op !== 0) {
      throw new Error(
        'test bug: encodeMultiSendBytes requires op=0; use encodeMultiSendTupleAllowingNonZeroOp for negative tests',
      );
    }
  }
  return libEncodeMultiSendBytes(
    tuples.map((t) => ({ to: t.to, value: t.value, data: t.data })),
  );
}

function encodeBatchedWrapperCallData(args: {
  approveCalldata: Hex;
  placeBetCalldata: Hex;
}): Hex {
  // Delegates to the production builder so happy-path fixtures
  // exercise the same wrapper shape that buildSponsoredUserOp emits.
  return encodeBatchedExecuteUserOpCallData([
    { to: USDC_ADDRESS, value: 0n, data: args.approveCalldata },
    { to: MAKO_ADDRESS, value: 0n, data: args.placeBetCalldata },
  ]);
}

// ── 1. Single placeBet — sponsor-time validator ─────────────────────────────

describe('assertBetSingleCall', () => {
  it('accepts placeBet(id, true, 100n) to MAKO with value=0', () => {
    expect(() =>
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(42n, true, 100n),
        },
      }),
    ).not.toThrow();
  });

  it('accepts placeBet(id, false, 1n)', () => {
    expect(() =>
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(0n, false, 1n),
        },
      }),
    ).not.toThrow();
  });

  it('rejects target ≠ MAKO with bad_placebet_args', () => {
    try {
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: NON_MAKO,
          value: 0n,
          data: encodePlaceBet(1n, true, 100n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NotAllowedError);
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('rejects nonzero value with bad_value', () => {
    try {
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 1n,
          data: encodePlaceBet(1n, true, 100n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects unrelated calldata with bad_placebet_args', () => {
    try {
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: MAKO_ADDRESS, value: 0n, data: '0xdeadbeef' as Hex },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('rejects amount === 0n with bad_placebet_args (zero-amount placeBet would revert)', () => {
    try {
      assertBetSingleCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(1n, true, 0n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('rejects unsupported chainId with bad_placebet_args', () => {
    try {
      assertBetSingleCall({
        chainId: 1,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(1n, true, 100n),
        },
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });
});

// ── 2. Batched [approve, placeBet] — sponsor-time validator ─────────────────

describe('assertBetBatchedCalls', () => {
  const goodApprove = {
    to: USDC_ADDRESS,
    value: 0n,
    data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
  };
  const goodPlaceBet = {
    to: MAKO_ADDRESS,
    value: 0n,
    data: encodePlaceBet(7n, true, 50n),
  };

  it('accepts [approve(MAKO, MaxUint256), placeBet(...)]', () => {
    expect(() =>
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [goodApprove, goodPlaceBet],
      }),
    ).not.toThrow();
  });

  it('NOTE: This validator does NOT see MultiSend bytes — wrapper-target / dataLen / bad_multisend_format cases live in the assertSponsoredCallData block', () => {
    // This is a marker test, no assertion needed. The matrix discipline
    // is documented above the file.
    expect(true).toBe(true);
  });

  it('rejects reversed order [placeBet, approve] with bad_approval_target', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [goodPlaceBet, goodApprove],
      });
      throw new Error('expected throw');
    } catch (e) {
      // tuple[0] target check fires first since approve target=USDC and
      // placeBet target=MAKO.
      expect((e as NotAllowedError).reason).toBe('bad_approval_target');
    }
  });

  it('rejects approve spender ≠ MAKO with bad_approval_target', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          {
            to: USDC_ADDRESS,
            value: 0n,
            data: encodeApprove(NON_MAKO, MAX_UINT_256),
          },
          goodPlaceBet,
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_target');
    }
  });

  it('rejects approve target ≠ USDC with bad_approval_target', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          {
            to: NON_USDC,
            value: 0n,
            data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
          },
          goodPlaceBet,
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_target');
    }
  });

  it('rejects approve amount === 0n with bad_approval_amount', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          {
            to: USDC_ADDRESS,
            value: 0n,
            data: encodeApprove(MAKO_ADDRESS, 0n),
          },
          goodPlaceBet,
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_amount');
    }
  });

  it('rejects approve amount === 1n with bad_approval_amount', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          {
            to: USDC_ADDRESS,
            value: 0n,
            data: encodeApprove(MAKO_ADDRESS, 1n),
          },
          goodPlaceBet,
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_amount');
    }
  });

  it('rejects approve amount === MaxUint256 - 1 with bad_approval_amount', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          {
            to: USDC_ADDRESS,
            value: 0n,
            data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256 - 1n),
          },
          goodPlaceBet,
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_amount');
    }
  });

  it('rejects placeBet target ≠ MAKO with bad_placebet_args', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          goodApprove,
          { to: NON_MAKO, value: 0n, data: encodePlaceBet(1n, true, 100n) },
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('rejects placeBet amount === 0n with bad_placebet_args', () => {
    try {
      assertBetBatchedCalls({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        calls: [
          goodApprove,
          {
            to: MAKO_ADDRESS,
            value: 0n,
            data: encodePlaceBet(1n, true, 0n),
          },
        ],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });
});

// ── 3. assertSponsoredCallData — send-time wrapper validator ────────────────

describe('assertSponsoredCallData (extended for batched)', () => {
  // ── single-call wrappers ──
  it('accepts op=0 wrapper around USDC.transfer(self, 1n) — smoke flow', async () => {
    const transferAbi = [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ] as const;
    const transferData = encodeFunctionData({
      abi: transferAbi,
      functionName: 'transfer',
      args: [SAFE, 1n],
    });
    const wrapped = encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [USDC_ADDRESS, 0n, transferData, 0],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts op=0 wrapper around MakoMarketsV4.placeBet(...) — bet_single flow', async () => {
    const wrapped = encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [MAKO_ADDRESS, 0n, encodePlaceBet(1n, true, 100n), 0],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects op=0 wrapper with unknown to (bad_to)', async () => {
    const wrapped = encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [NON_MAKO, 0n, encodePlaceBet(1n, true, 100n), 0],
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_to');
    }
  });

  // ── batched MultiSend wrappers ──
  it('accepts op=1 wrapper to canonical MultiSendCallOnly with valid [approve, placeBet]', async () => {
    const wrapped = encodeBatchedWrapperCallData({
      approveCalldata: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      placeBetCalldata: encodePlaceBet(1n, true, 100n),
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects op=1 wrapper to ≠ canonical MultiSendCallOnly with bad_multisend_target', async () => {
    const wrapped = buildBadOuterArgsWrapper({
      to: NON_MAKO, // bad outer target
      value: 0n,
      calls: [
        {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
        },
        {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(1n, true, 100n),
        },
      ],
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_target');
    }
  });

  it('rejects op=1 wrapper with dataLen > Number.MAX_SAFE_INTEGER (bad_multisend_format)', async () => {
    // Round-2 MINOR 2 lock-in: explicit bigint-overflow boundary case.
    // Encode a header with dataLen = 2^53 (one above MAX_SAFE_INTEGER).
    // The parser MUST reject this BEFORE Number() coercion, otherwise
    // a malicious payload could request more memory than addressable.
    const oversizedDataLen = (1n << 53n); // = Number.MAX_SAFE_INTEGER + 1
    const malicious = ('0x' +
      '00' + // op
      USDC_ADDRESS.slice(2) +
      '00'.repeat(32) + // value 0
      pad(toHex(oversizedDataLen), { size: 32 }).slice(2) +
      // No actual data follows — bounds check fires before we'd slice.
      '') as Hex;
    // Wrap the malformed packed bytes in multiSend(bytes) ABI calldata
    // so the wrapper passes the outer ABI decode and the malformed
    // bytes reach parseMultiSendBytes.
    const wrapped = buildWrappedMultiSendWrapper(malicious);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_format');
    }
  });

  it('rejects op=1 wrapper with valid tuple bytes followed by trailing junk (bad_multisend_format)', async () => {
    // Round-2 MINOR 2 lock-in: valid 2-tuple bytes + extra trailing
    // garbage that doesn't form a well-formed third tuple. The end-of-
    // parse `cursor === total` assertion must fire.
    const validTuples = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      {
        op: 0,
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      },
    ]);
    const withJunk = (validTuples + 'aabbccdd') as Hex;
    const wrapped = buildWrappedMultiSendWrapper(withJunk);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_format');
    }
  });

  it('rejects op=1 wrapper with truncated multisend bytes (bad_multisend_format)', async () => {
    // Header claims dataLen but data is short.
    const truncated = ('0x' +
      '00' + // op
      USDC_ADDRESS.slice(2) +
      '00'.repeat(32) + // value 0
      pad(toHex(64n), { size: 32 }).slice(2) + // claims 64 bytes data
      'aa') as Hex; // only 1 byte of data
    const wrapped = buildWrappedMultiSendWrapper(truncated);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_format');
    }
  });

  it('rejects op=1 wrapper with empty multisend bytes (bad_subcall_count)', async () => {
    const wrapped = buildWrappedMultiSendWrapper('0x' as Hex);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_subcall_count');
    }
  });

  it('rejects op=1 wrapper with one sub-call (bad_subcall_count)', async () => {
    const multiSendBytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
    ]);
    const wrapped = buildWrappedMultiSendWrapper(multiSendBytes);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_subcall_count');
    }
  });

  it('rejects op=1 wrapper with three sub-calls (bad_subcall_count)', async () => {
    const multiSendBytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      {
        op: 0,
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      },
      {
        op: 0,
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(2n, false, 50n),
      },
    ]);
    const wrapped = buildWrappedMultiSendWrapper(multiSendBytes);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_subcall_count');
    }
  });

  it('rejects sub-call op=1 inside MultiSend (bad_subcall_op)', async () => {
    // Negative test: simulate a malicious payload where the FIRST
    // sub-call has op=1 (delegatecall). The lib's production
    // `encodeMultiSendBytes` hardcodes op=0, so we use the test-only
    // `encodeMultiSendTupleAllowingNonZeroOp` helper to compose this
    // shape directly + concat.
    const multiSendBytes = concat([
      encodeMultiSendTupleAllowingNonZeroOp({
        op: 1, // delegatecall in inner — forbidden
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      }),
      encodeMultiSendTupleAllowingNonZeroOp({
        op: 0,
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      }),
    ]) as Hex;
    const wrapped = buildWrappedMultiSendWrapper(multiSendBytes);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_subcall_op');
    }
  });

  it('rejects inner approve amount ≠ MaxUint256 (bad_approval_amount)', async () => {
    const wrapped = encodeBatchedWrapperCallData({
      approveCalldata: encodeApprove(MAKO_ADDRESS, MAX_UINT_256 - 1n),
      placeBetCalldata: encodePlaceBet(1n, true, 100n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_amount');
    }
  });

  it('rejects inner approve spender ≠ MAKO (bad_approval_target)', async () => {
    const wrapped = encodeBatchedWrapperCallData({
      approveCalldata: encodeApprove(NON_MAKO, MAX_UINT_256),
      placeBetCalldata: encodePlaceBet(1n, true, 100n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_approval_target');
    }
  });

  it('rejects inner placeBet target ≠ MAKO with bad_multisend_target (Codex r1 MAJ-1: dispatcher now discriminates on sub[1].to)', async () => {
    const multiSendBytes = encodeMultiSendBytes([
      {
        op: 0,
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      {
        op: 0,
        to: NON_MAKO, // wrong — neither MAKO nor PM
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      },
    ]);
    const wrapped = buildWrappedMultiSendWrapper(multiSendBytes);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      // Pre-r1: validator naively assumed sub[1] was placeBet → MAKO,
      // so wrong target surfaced as `bad_placebet_args`. Post-r1 the
      // dispatcher rejects unknown sub[1].to BEFORE running the placeBet
      // validator (with PM batched bet/stake now also valid). The
      // surfaced reason is `bad_multisend_target`, which is strictly
      // more accurate (the target IS what's wrong).
      expect((e as NotAllowedError).reason).toBe('bad_multisend_target');
    }
  });

  it('rejects inner placeBet amount === 0n (bad_placebet_args)', async () => {
    const wrapped = encodeBatchedWrapperCallData({
      approveCalldata: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      placeBetCalldata: encodePlaceBet(1n, true, 0n),
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('rejects op=1 wrapper with nonzero outer value (bad_value)', async () => {
    const wrapped = buildBadOuterArgsWrapper({
      to: SAFE_CONFIG.multiSendCallOnly,
      value: 1n, // bad outer value
      calls: [
        {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
        },
        {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodePlaceBet(1n, true, 100n),
        },
      ],
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects op=2 (CREATE) outer wrapper (bad_operation)', async () => {
    const wrapped = encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [MAKO_ADDRESS, 0n, encodePlaceBet(1n, true, 100n), 2],
    });
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_operation');
    }
  });

  // ── Phase 1D hotfix regression coverage ──────────────────────────────────

  it('production builder produces validator-acceptable wrapper (cross-module pin)', async () => {
    // Build the wrapper via the SAME function buildSponsoredUserOp uses
    // in production. Decode it and assert every outer field, then run
    // the validator and confirm acceptance. This is the cross-module
    // contract that was missing in Group 4 — every prior test
    // independently encoded the wrapper one way or the other, so the
    // pre-fix bug shipped despite full unit coverage.
    const wrapper = encodeBatchedExecuteUserOpCallData([
      {
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      {
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      },
    ]);
    // Decode the outer executeUserOp wrapper. Every field must be
    // exactly what the validator expects.
    const decodedOuter = decodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      data: wrapper,
    });
    expect(decodedOuter.functionName).toBe('executeUserOp');
    const [to, value, innerData, operation] = decodedOuter.args as readonly [
      Address,
      bigint,
      Hex,
      number,
    ];
    expect(to.toLowerCase()).toBe(
      SAFE_CONFIG.multiSendCallOnly.toLowerCase(),
    );
    expect(value).toBe(0n);
    expect(operation).toBe(1);
    // Inner data MUST start with the multiSend(bytes) selector
    // 0x8d80ff0a — this is exactly what the pre-fix bug got wrong.
    expect(innerData.slice(0, 10).toLowerCase()).toBe('0x8d80ff0a');
    // And the validator accepts the whole shape.
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapper,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects pre-fix raw-packed-bytes wrapper shape with bad_multisend_calldata', async () => {
    // Pin the regression: pre-fix buildSponsoredUserOp passed the
    // packed multisend bytes STRAIGHT as the third arg, with no
    // multiSend(bytes) ABI wrap. On chain that hit no function on
    // MultiSendCallOnly and reverted with ExecutionFailed() (selector
    // 0xacfdb444). The fix decodes the third arg as multiSend(bytes)
    // first; raw packed bytes fail that decode and surface as
    // bad_multisend_calldata. If a future refactor regresses to the
    // pre-fix shape, this test fails LOUDLY instead of producing a
    // chain-invalid userOp.
    const rawPacked = libEncodeMultiSendBytes([
      {
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      {
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodePlaceBet(1n, true, 100n),
      },
    ]);
    const wrapped = buildPreFixRawWrapper(rawPacked);
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapped,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_multisend_calldata');
    }
  });
});
