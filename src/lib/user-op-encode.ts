// Client-safe Safe4337 wrapper encoders (no server-only imports): the single-call executeUserOp wrapper and the
// MultiSendCallOnly batched wrapper. Moved out of user-op.ts, which is server-only, so the browser can rebuild the
// callData of an operation it is asked to sign (INBOX_GAP_PLAN r10 item 6). user-op.ts re-exports them.

import { concat, encodeFunctionData, pad, toHex, type Address, type Hex } from 'viem';

import { SAFE_CONFIG } from './safe-config';

/// Safe4337Module v0.3.0 — wraps a single inner call so the EntryPoint can
/// dispatch into `executeUserOp(to, value, data, operation)`. The probe
/// already validated this against live Pimlico; same wrapper here.
const SAFE_4337_MODULE_ABI = [
  {
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/// MultiSendCallOnly v1.4.1 — single function `multiSend(bytes
/// transactions)`. The bytes payload is the packed
/// `op(1)||to(20)||value(32)||dataLen(32)||data` tuples produced by
/// `encodeMultiSendBytes`. Selector 0x8d80ff0a — must match what
/// `assertSponsoredCallData` decodes on the send-side. Function is
/// declared payable in MultiSendCallOnly's source; we still pass
/// value=0 at the outer wrapper layer.
///
/// REQUIRED MULTISEND WRAP: Safe delegatecalls the wrapper data
/// verbatim, so without the `multiSend(bytes)` ABI wrap the first 4
/// bytes don't match any function on MultiSendCallOnly and the call
/// reverts. Safe4337Module then re-emits ExecutionFailed() (selector
/// 0xacfdb444). This bug shipped in Phase 1D Group 3 and was caught
/// during the first real bet attempt 2026-05-02.
const MULTISEND_CALL_ONLY_ABI = [
  {
    name: 'multiSend',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/// EntryPoint v0.7 minimal ABI for `getNonce(sender, key)` reads.

// ── MultiSend bytes encoder (Phase 1D) ──────────────────────────────────────

/// Encode a sequence of `[op, to, value, dataLen, data]` tuples in Safe's
/// MultiSend format for the bet-flow's batched user op:
///   tuple = op(1) || to(20) || value(32 BE) || dataLen(32 BE) || data
///
/// All sub-calls are emitted with `op=0` (CALL only) — MultiSendCallOnly
/// rejects op=1 internally, so this is both correct and defensive. The
/// send-side `assertSponsoredCallData` parses these bytes back and
/// validates the same shape; the encoder + parser must agree.
///
/// Plan v4 §"Architectural decisions": only the canonical
/// `MultiSendCallOnly` is permitted as the wrapper target. The wrapper
/// itself is built in `buildSponsoredUserOp` step 4 — this function only
/// produces the `data` argument.
export function encodeMultiSendBytes(
  calls: readonly { to: Address; value: bigint; data: Hex }[],
): Hex {
  const parts: Hex[] = [];
  for (const call of calls) {
    const dataHex = (
      call.data.startsWith('0x') ? call.data.slice(2) : call.data
    ) as string;
    const dataLen = BigInt(dataHex.length / 2);
    parts.push(
      concat([
        toHex(0, { size: 1 }), // op = CALL
        call.to,
        pad(toHex(call.value), { size: 32 }),
        pad(toHex(dataLen), { size: 32 }),
        call.data,
      ]) as Hex,
    );
  }
  return concat(parts) as Hex;
}

/// Build the wrapper.callData for a batched bet_batched user op.
/// Composes encodeMultiSendBytes -> multiSend(bytes) ABI wrap ->
/// Safe.executeUserOp(MultiSendCallOnly, 0, ms, 1).
///
/// Single source of truth for the batched wrapper. Production code
/// (buildSponsoredUserOp) AND tests both call this. Do not roll a
/// local "mirror of the wrapper build path" — that's how the pre-
/// fix bug shipped (test fixtures and production were independently
/// wrong but self-consistent).
///
/// Type narrowed to a 2-tuple [approve, placeBet] to match
/// BuildSponsoredUserOpArgs.calls — bet_batched is specifically
/// that shape, not a general N-call helper.
/// Single source of truth for the single-call Safe wrapper. Production
/// code (buildSponsoredUserOp) AND tests both call this. Same hardening
/// rationale as `encodeBatchedExecuteUserOpCallData` below: rolling a
/// local mirror in tests is exactly how the wrapper-hotfix bug shipped.
///
/// Used by every single-call sponsored kind: smoke, bet_single,
/// send_usdc, create_market.
export function encodeSingleExecuteUserOpCallData(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): Hex {
  return encodeFunctionData({
    abi: SAFE_4337_MODULE_ABI,
    functionName: 'executeUserOp',
    args: [call.to, call.value, call.data, 0],
  });
}

export function encodeBatchedExecuteUserOpCallData(
  calls: readonly [
    { to: Address; value: bigint; data: Hex },
    { to: Address; value: bigint; data: Hex },
  ],
): Hex {
  const packed = encodeMultiSendBytes(calls);
  const multiSendCallData = encodeFunctionData({
    abi: MULTISEND_CALL_ONLY_ABI,
    functionName: 'multiSend',
    args: [packed],
  });
  return encodeFunctionData({
    abi: SAFE_4337_MODULE_ABI,
    functionName: 'executeUserOp',
    args: [SAFE_CONFIG.multiSendCallOnly, 0n, multiSendCallData, 1],
  });
}

/// The Safe wrapper callData a sponsored op carries for its inner call(s): the single-call wrapper, or the
/// MultiSendCallOnly wrapper for a batched pair. buildSponsoredUserOp builds with it, and /api/aa/sponsor compares a
/// stored pending op against a new request with it, so the two can never disagree.
export function wrapperCallDataFor(args: {
  call?: { to: Address; value: bigint; data: Hex };
  calls?: readonly [{ to: Address; value: bigint; data: Hex }, { to: Address; value: bigint; data: Hex }];
}): Hex {
  const hasSingle = args.call !== undefined;
  const hasBatched = args.calls !== undefined;
  if (hasSingle === hasBatched) {
    throw new Error(
      'user-op: buildSponsoredUserOp requires exactly one of `call` or `calls` (got ' +
        (hasSingle ? 'both' : 'neither') +
        ').',
    );
  }
  return hasSingle ? encodeSingleExecuteUserOpCallData(args.call!) : encodeBatchedExecuteUserOpCallData(args.calls!);
}
