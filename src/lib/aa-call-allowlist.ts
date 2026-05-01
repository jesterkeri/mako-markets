import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/aa-call-allowlist.ts
//
// Validators for the calls that the Pimlico paymaster will sponsor. THREE
// sponsor-time entry points + ONE send-time entry point. The split mirrors
// the request-time vs persisted-wrapper distinction (Phase 1D plan v4
// MAJOR 2 fix):
//
//   assertSponsorableCall({ chainId, safeAddress, call })
//     SMOKE flow only. Used by /api/aa/sponsor when kind='smoke'.
//     Validates a single inner call against the strict
//     USDC.transfer(safeAddress, 0n|1n) allowlist.
//
//   assertBetSingleCall({ chainId, safeAddress, call })
//     BET flow, allowance >= amount. Used by /api/aa/sponsor when
//     kind='bet_single'. Validates a single placeBet call to MakoMarketsV4.
//
//   assertBetBatchedCalls({ chainId, safeAddress, calls })
//     BET flow, allowance < amount. Used by /api/aa/sponsor when
//     kind='bet_batched'. Validates a raw two-element TUPLE of calls
//     [approve(MAKO, MaxUint256), placeBet(...)] BEFORE the lib's
//     buildSponsoredUserOp wraps them in a MultiSend bytes payload.
//     The MultiSend wrapper does NOT exist at this point.
//
//   assertSponsoredCallData({ chainId, safeAddress, callData })
//     SEND-time defense-in-depth. Used by /api/aa/send to re-validate
//     the persisted userOp.callData. Decodes the wrapper selector
//     (Safe.executeUserOp{,WithErrorString}); if op=0, runs the smoke /
//     bet_single inner-call invariants. If op=1, the wrapper.to MUST
//     be canonical MultiSendCallOnly and the inner data is parsed as
//     MultiSend bytes — the [approve, placeBet] sub-calls are validated
//     identically to assertBetBatchedCalls.
//
// 1B-D's allowlists are deliberately tight: USDC.transfer(safe, 0n|1n)
// for smoke, plus the bet shapes for 1D. Phase 1E and beyond extend.
//
// `transfer(address,uint256)`, `approve(address,uint256)`, the placeBet
// fragment, and the MultiSendCallOnly wrapper ABI are all shipped here as
// minimal local fragments. We deliberately don't import from `usdc.ts`
// (transfer is omitted there per Phase 1C decision) or `MakoMarkets.abi.ts`
// (full v4 ABI, way more than needed for placeBet decode).
// ----------------------------------------------------------------------------

import {
  decodeFunctionData,
  hexToBigInt,
  hexToBytes,
  type Address,
  type Hex,
} from 'viem';

import { MAKO_ADDRESS } from './contract';
import { MONAD_TESTNET_ID } from './chain';
import { SAFE_CONFIG } from './safe-config';
import { USDC_ADDRESS } from './usdc';

const MAX_UINT_256 = (1n << 256n) - 1n;

/// Reasons the allowlist may reject a call. Surfaces in the route's 403
/// response body so operators can debug a misconfigured client without
/// exposing the underlying call shape.
export type NotAllowedReason =
  | 'bad_to'
  | 'bad_value'
  | 'bad_inner_recipient'
  | 'bad_amount'
  | 'bad_selector'
  | 'bad_operation'
  // Phase 1D bet flow:
  | 'bad_multisend_target'
  | 'bad_multisend_format'
  | 'bad_subcall_count'
  | 'bad_subcall_op'
  | 'bad_approval_target'
  | 'bad_approval_amount'
  | 'bad_placebet_args';

export class NotAllowedError extends Error {
  constructor(public readonly reason: NotAllowedReason, message?: string) {
    super(message ?? `aa-call-allowlist: ${reason}`);
    this.name = 'NotAllowedError';
  }
}

// ── ABI fragments ───────────────────────────────────────────────────────────

/// `transfer(address,uint256)`. Used by smoke flow's inner-call decode.
const TRANSFER_ABI = [
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

/// `approve(address,uint256)`. Used by bet flow's batched first-call decode.
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

/// `placeBet(uint256, bool, uint256)`. Phase 1D bet flow. Mirrors the v4
/// contract's `placeBet(id, isYes, amount)` selector exactly.
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

/// Safe4337Module wrapper selectors. Both round-trip — the SDK chooses
/// either depending on whether it wants the error-string variant.
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
  {
    type: 'function',
    name: 'executeUserOpWithErrorString',
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

// ── Per-chain target lookup ─────────────────────────────────────────────────

/// Allowed inner-call targets for the SMOKE flow only. Bet flow uses
/// MAKO_ADDRESS + USDC_ADDRESS directly — see assertBetSingleCall +
/// assertBetBatchedCalls.
function smokeAllowedInnerTargets(chainId: number): readonly Address[] {
  if (chainId === MONAD_TESTNET_ID) {
    return [USDC_ADDRESS] as const;
  }
  return [] as const;
}

/// Allowed transfer amounts for smoke. `0n` = probe; `1n` = dev surface.
const SMOKE_ALLOWED_TRANSFER_AMOUNTS = new Set<bigint>([0n, 1n]);

// ── Shared decoders ─────────────────────────────────────────────────────────

/// Decode the bet's `placeBet(id, isYes, amount)` and assert the production-
/// safety invariants. Throws structured NotAllowedError on any failure.
/// Used by:
///   - assertBetSingleCall     (sponsor-time, single placeBet)
///   - assertBetBatchedCalls   (sponsor-time, tuple[1] inner placeBet)
///   - assertSponsoredCallData (send-time, inner placeBet inside MultiSend)
function decodeAndAssertPlaceBet(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  // target check first — wrong target is the most common misconfig.
  if (call.to.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_placebet_args');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }

  let decoded: {
    functionName: 'placeBet';
    args: readonly [bigint, boolean, bigint];
  };
  try {
    const result = decodeFunctionData({
      abi: PLACEBET_ABI,
      data: call.data,
    });
    if (result.functionName !== 'placeBet') {
      throw new NotAllowedError('bad_placebet_args');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_placebet_args');
  }

  const [, isYes, amount] = decoded.args;
  // amount > 0n — a zero-amount placeBet would revert on chain (round-3
  // MINOR 3 fix; lock-in for both sponsor-time and send-time).
  if (amount <= 0n) {
    throw new NotAllowedError('bad_placebet_args');
  }
  // isYes is enforced as a valid bool by viem's decoder, but assert
  // defensively (typeof check survives if the decoder ever loosens).
  if (typeof isYes !== 'boolean') {
    throw new NotAllowedError('bad_placebet_args');
  }
}

/// Decode `approve(spender, amount)` and assert the bet-flow invariants.
/// Used by:
///   - assertBetBatchedCalls   (sponsor-time, tuple[0])
///   - assertSponsoredCallData (send-time, inner approve inside MultiSend)
function decodeAndAssertApprove(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  if (call.to.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_approval_target');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }

  let decoded: {
    functionName: 'approve';
    args: readonly [Address, bigint];
  };
  try {
    const result = decodeFunctionData({
      abi: APPROVE_ABI,
      data: call.data,
    });
    if (result.functionName !== 'approve') {
      throw new NotAllowedError('bad_approval_target');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_approval_target');
  }

  const [spender, amount] = decoded.args;
  if (spender.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_approval_target');
  }
  // Approve amount must be EXACTLY MaxUint256 — round-1 MINOR 2 lock-in.
  if (amount !== MAX_UINT_256) {
    throw new NotAllowedError('bad_approval_amount');
  }
}

// ── Smoke validator (unchanged from sub-phase D) ─────────────────────────────

/// Validate a single inner call for the SMOKE flow. Throws
/// `NotAllowedError(reason)` on any invariant failure; returns void on
/// success. The route catches the throw and maps to a 403 with the reason.
export function assertSponsorableCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  const targets = smokeAllowedInnerTargets(args.chainId);
  if (
    !targets.some(
      (addr) => addr.toLowerCase() === args.call.to.toLowerCase(),
    )
  ) {
    throw new NotAllowedError('bad_to');
  }
  if (args.call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }

  let decoded: { args: readonly [Address, bigint] };
  try {
    const result = decodeFunctionData({
      abi: TRANSFER_ABI,
      data: args.call.data,
    });
    if (result.functionName !== 'transfer') {
      throw new NotAllowedError('bad_selector');
    }
    decoded = result as unknown as { args: readonly [Address, bigint] };
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_selector');
  }

  const [recipient, amount] = decoded.args;
  if (recipient.toLowerCase() !== args.safeAddress.toLowerCase()) {
    throw new NotAllowedError('bad_inner_recipient');
  }
  if (!SMOKE_ALLOWED_TRANSFER_AMOUNTS.has(amount)) {
    throw new NotAllowedError('bad_amount');
  }
}

// ── Bet validators (Phase 1D) ───────────────────────────────────────────────

/// Validate a single `placeBet(...)` call (sponsor-time, kind='bet_single').
/// `safeAddress` is unused at this layer — the placeBet sender check happens
/// on chain via `msg.sender` semantics. Kept in the signature for parity
/// with the other validators + future expansion.
export function assertBetSingleCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  // chainId allowlist parallels the smoke validator — no targets if the
  // chain isn't supported.
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_placebet_args');
  }
  decodeAndAssertPlaceBet(args.call);
}

/// Validate a raw two-element `[approve, placeBet]` tuple (sponsor-time,
/// kind='bet_batched'). The MultiSend wrapper does NOT exist at this
/// point — the route validates the input tuple BEFORE the lib's
/// buildSponsoredUserOp wraps it.
export function assertBetBatchedCalls(args: {
  chainId: number;
  safeAddress: Address;
  calls: readonly [
    { to: Address; value: bigint; data: Hex },
    { to: Address; value: bigint; data: Hex },
  ];
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_placebet_args');
  }

  // Ordering: tuple[0] is the approve, tuple[1] is the placeBet.
  // A reversed-order tuple → bad_approval_target (tuple[0] target check
  // fires first since approve target=USDC and placeBet target=MAKO).
  decodeAndAssertApprove(args.calls[0]);
  decodeAndAssertPlaceBet(args.calls[1]);
}

// ── MultiSend bytes parser (send-time only) ─────────────────────────────────

/// Safe MultiSend tuple format (packed):
///   op(1) || to(20) || value(32) || dataLen(32) || data(dataLen bytes)
///
/// For 1D's batched bet shape we expect EXACTLY two tuples in the order
/// [approve, placeBet]. The parser:
///   1. Walks the bytes with bigint cursor + bigint offsets.
///   2. Bounds-checks `dataLen` BEFORE any `Number()` coercion. Hard
///      rejects `dataLen > Number.MAX_SAFE_INTEGER` (defensive against
///      a malicious payload claiming more data than addressable).
///   3. Asserts each sub-call's `op === 0` (CALL only — MultiSendCallOnly
///      enforces this internally too, but double-validation is intentional).
///   4. Asserts `cursor === input.length` at end (no trailing junk).
///   5. Asserts exactly 2 tuples parsed.
///   6. Validates the [approve, placeBet] ordering by delegating to the
///      shared `decodeAndAssertApprove` / `decodeAndAssertPlaceBet`.
///
/// Throws `NotAllowedError(reason)` on every rejection path. NEVER
/// rethrows a generic `Error` (would surface as 500 in the route's catch).
type ParsedSubCall = { op: number; to: Address; value: bigint; data: Hex };

function parseMultiSendBytes(input: Hex): readonly ParsedSubCall[] {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(input);
  } catch {
    throw new NotAllowedError('bad_multisend_format');
  }

  const total = BigInt(bytes.length);
  let cursor = 0n;
  const sub: ParsedSubCall[] = [];

  while (cursor < total) {
    // Tuple header is 85 bytes (op 1 + to 20 + value 32 + dataLen 32).
    const remainingForHeader = total - cursor;
    if (remainingForHeader < 85n) {
      throw new NotAllowedError('bad_multisend_format');
    }

    const opByte = bytes[Number(cursor)];
    const toBytes = bytes.subarray(Number(cursor) + 1, Number(cursor) + 21);
    const valueBytes = bytes.subarray(Number(cursor) + 21, Number(cursor) + 53);
    const dataLenBytes = bytes.subarray(
      Number(cursor) + 53,
      Number(cursor) + 85,
    );

    // Decode value (uint256 BE) and dataLen (uint256 BE) as bigint.
    const valueHex = ('0x' + bytesToHexLower(valueBytes)) as Hex;
    const dataLenHex = ('0x' + bytesToHexLower(dataLenBytes)) as Hex;
    const value = hexToBigInt(valueHex);
    const dataLen = hexToBigInt(dataLenHex);

    // Bounds checks — bigint everywhere until we know it's safe.
    if (dataLen < 0n) {
      throw new NotAllowedError('bad_multisend_format');
    }
    if (dataLen > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new NotAllowedError('bad_multisend_format');
    }
    const remainingForData = total - cursor - 85n;
    if (dataLen > remainingForData) {
      throw new NotAllowedError('bad_multisend_format');
    }

    // Now safe to convert to Number for slicing.
    const dataLenNum = Number(dataLen);
    const dataStart = Number(cursor) + 85;
    const data = ('0x' +
      bytesToHexLower(
        bytes.subarray(dataStart, dataStart + dataLenNum),
      )) as Hex;

    const to = ('0x' + bytesToHexLower(toBytes)) as Address;

    if (opByte !== 0) {
      throw new NotAllowedError('bad_subcall_op');
    }

    sub.push({ op: opByte, to, value, data });
    cursor += 85n + dataLen;
  }

  if (cursor !== total) {
    // Trailing junk after the last tuple.
    throw new NotAllowedError('bad_multisend_format');
  }
  return sub;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

// ── Send-time validator (extended in Phase 1D) ──────────────────────────────

/// Validate the WRAPPED userOp.callData posted at /api/aa/send for
/// post-sign verification + dev-surface decoding. Two paths:
///
///   op === 0: routes to the smoke / bet_single inner-call invariants.
///             Wrapper.to is the inner target (e.g., USDC for smoke, MAKO
///             for bet_single).
///
///   op === 1: ONLY accepted when wrapper.to === canonical
///             MultiSendCallOnly. Inner data is parsed as MultiSend bytes;
///             must contain exactly 2 sub-calls in [approve, placeBet]
///             order. Each sub-call must have op=0 (MultiSendCallOnly
///             enforces internally too).
///
/// Anything else throws `NotAllowedError(reason)`.
export function assertSponsoredCallData(args: {
  chainId: number;
  safeAddress: Address;
  callData: Hex;
}): void {
  let decoded: {
    functionName: 'executeUserOp' | 'executeUserOpWithErrorString';
    args: readonly [Address, bigint, Hex, number];
  };
  try {
    const result = decodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      data: args.callData,
    });
    if (
      result.functionName !== 'executeUserOp' &&
      result.functionName !== 'executeUserOpWithErrorString'
    ) {
      throw new NotAllowedError('bad_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_selector');
  }

  const [to, value, data, operation] = decoded.args;

  if (operation === 0) {
    // CALL — single inner call. Smoke flow → assertSponsorableCall;
    // bet_single → decodeAndAssertPlaceBet. We dispatch by `to`: USDC
    // means smoke (the only sponsor-time path that hits USDC), MAKO
    // means bet_single, anything else → bad_to.
    if (to.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      assertSponsorableCall({
        chainId: args.chainId,
        safeAddress: args.safeAddress,
        call: { to, value, data },
      });
      return;
    }
    if (to.toLowerCase() === MAKO_ADDRESS.toLowerCase()) {
      // Mirror the sponsor-time chainId guard. The send-side validator
      // is meant to defend persisted callData independently of the
      // sponsor route — round-1 MINOR 1 fix.
      if (args.chainId !== MONAD_TESTNET_ID) {
        throw new NotAllowedError('bad_placebet_args');
      }
      decodeAndAssertPlaceBet({ to, value, data });
      return;
    }
    throw new NotAllowedError('bad_to');
  }

  if (operation === 1) {
    // DELEGATECALL — Phase 1D MultiSend wrapper. Permitted ONLY when
    // wrapper.to is the canonical MultiSendCallOnly. Anything else is a
    // delegatecall foot-gun.
    if (
      to.toLowerCase() !== SAFE_CONFIG.multiSendCallOnly.toLowerCase()
    ) {
      throw new NotAllowedError('bad_multisend_target');
    }
    // Mirror the sponsor-time chainId guard for bet flow — round-1
    // MINOR 1 fix. Even though Stage 1 rows only come from the sponsor
    // route (which already validates chainId), the send-side mirror is
    // an independent defense layer.
    if (args.chainId !== MONAD_TESTNET_ID) {
      throw new NotAllowedError('bad_placebet_args');
    }
    // Outer wrapper carries no native value; the inner sub-calls also
    // carry no value (validated inside parseMultiSendBytes via
    // value === 0n in the per-call decoders).
    if (value !== 0n) {
      throw new NotAllowedError('bad_value');
    }

    const sub = parseMultiSendBytes(data);
    if (sub.length !== 2) {
      throw new NotAllowedError('bad_subcall_count');
    }
    decodeAndAssertApprove({
      to: sub[0].to,
      value: sub[0].value,
      data: sub[0].data,
    });
    decodeAndAssertPlaceBet({
      to: sub[1].to,
      value: sub[1].value,
      data: sub[1].data,
    });
    return;
  }

  // Any other operation value — Safe defines op=0 (CALL) and op=1
  // (DELEGATECALL); op=2 (CREATE) is not part of the userOp wrapper
  // surface. Reject defensively.
  throw new NotAllowedError('bad_operation');
}
