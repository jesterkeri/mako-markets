// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-test-helpers.ts
//
// Single source of truth for op=1 (delegatecall) `executeUserOp` wrapper
// builds in tests. Replaces the inline `encodeFunctionData({ abi:
// SAFE_WRAPPER_ABI, functionName: 'executeUserOp', args: [..., 1] })`
// pattern that previously lived in every test file.
//
// Why one file: the production code (src/lib/user-op.ts) and the
// validator (src/lib/aa-call-allowlist.ts) both encode the rule that
// the third arg of an op=1 wrapper MUST be `multiSend(bytes)` ABI
// calldata, NOT raw packed bytes. Pre-fix, both production and tests
// independently encoded the wrong shape; tests passed because they
// were self-consistent. Concentrating every hand-built op=1 wrapper
// in this file means a reviewer reads ONE file once to catch shape
// drift, instead of grep-auditing every fixture.
//
// Migration rule (Phase 1D hotfix): no inline `encodeFunctionData(...
// executeUserOp(..., 1) ...)` build is permitted outside this file.
// Production happy-path tests use `encodeBatchedExecuteUserOpCallData`
// re-exported below. Negative tests use the named builders.
// ----------------------------------------------------------------------------

import { encodeFunctionData, type Address, type Hex } from 'viem';

import { SAFE_CONFIG } from '../safe-config';
import {
  encodeBatchedExecuteUserOpCallData,
  encodeMultiSendBytes,
} from '../user-op';

export { encodeBatchedExecuteUserOpCallData };

/// Local copies of ABI fragments. Mirror the production snippets in
/// user-op.ts and aa-call-allowlist.ts; keeping them local keeps the
/// helper file self-contained for tests.
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

const MULTISEND_CALL_ONLY_ABI = [
  {
    type: 'function',
    name: 'multiSend',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

type Call = { to: Address; value: bigint; data: Hex };

/// Wrap arbitrary packed bytes in `multiSend(bytes)` ABI calldata.
/// Used by `buildBadOuterArgsWrapper` (which needs valid inner data
/// but bad outer args) and `buildWrappedMultiSendWrapper` (which
/// needs valid wrapper shape but caller-controlled inner bytes).
function wrapInMultiSendCalldata(packed: Hex): Hex {
  return encodeFunctionData({
    abi: MULTISEND_CALL_ONLY_ABI,
    functionName: 'multiSend',
    args: [packed],
  });
}

/// Build the pre-fix bug shape: `executeUserOp(MultiSendCallOnly, 0n,
/// rawPacked, 1)` where `rawPacked` is the packed MultiSend tuples
/// passed STRAIGHT as the third arg, with no `multiSend(bytes)` ABI
/// wrap. This is the exact wrapper Phase 1D Group 3 shipped before
/// the hotfix; use ONLY in the regression test that pins
/// `bad_multisend_calldata` rejection.
///
/// Anywhere else, this is the bug — use one of the wrapped
/// helpers below.
export function buildPreFixRawWrapper(packed: Hex): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [SAFE_CONFIG.multiSendCallOnly, 0n, packed, 1],
  });
}

/// Build a wrapper with caller-supplied outer `to` and/or `value`,
/// but VALID `multiSend(bytes)` ABI inner data. The validator's
/// outer-arg checks (`bad_multisend_target`, `bad_value`) fire
/// before the inner ABI decode, so the inner shape is irrelevant
/// to what the test asserts.
///
/// Used for `bad_multisend_target` (caller passes non-canonical
/// `to`) and `bad_value` (caller passes non-zero `value`) tests.
/// Pass at least one bad outer arg; otherwise this is the same as
/// `encodeBatchedExecuteUserOpCallData` and the test will accept.
export function buildBadOuterArgsWrapper(args: {
  to: Address;
  value: bigint;
  calls: readonly [Call, Call];
}): Hex {
  const packed = encodeMultiSendBytes(args.calls);
  const inner = wrapInMultiSendCalldata(packed);
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [args.to, args.value, inner, 1],
  });
}

/// Build a wrapper with VALID outer args (canonical
/// MultiSendCallOnly + value=0), `multiSend(bytes)` ABI-wrapped
/// inner data, but caller-supplied INNER packed bytes. The packed
/// bytes may be deliberately malformed — this is how parser-
/// negative tests reach `parseMultiSendBytes` with bad input.
///
/// Used for `bad_multisend_format` (truncated tuple, dataLen
/// overflow, etc.), `bad_subcall_count` (0/1/3 sub-tuples), and
/// `bad_subcall_op` (op=1 in a sub-tuple — MultiSendCallOnly
/// would also reject this internally, but the validator catches
/// it earlier).
export function buildWrappedMultiSendWrapper(packedBytes: Hex): Hex {
  const inner = wrapInMultiSendCalldata(packedBytes);
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [SAFE_CONFIG.multiSendCallOnly, 0n, inner, 1],
  });
}
