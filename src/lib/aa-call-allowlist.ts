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

import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS } from './contract';
import { MONAD_TESTNET_ID } from './chain';
import { SAFE_CONFIG } from './safe-config';
import { USDC_ADDRESS } from './usdc';
import {
  CREATE_MARKET_QUESTION_MAX_BYTES,
  CREATE_MARKET_MIN_SERVER_BUFFER_SEC,
  MAKO_V4_MAX_DURATION_SEC,
  MAKO_V4_MIN_DURATION_SEC,
  PM_MAX_ALLOWLIST,
  PM_MAX_DESCRIPTION_BYTES,
  PM_MAX_OPTION_LABEL_BYTES,
  PM_MAX_OPTIONS,
  PM_MAX_STREAM_URL_BYTES,
  PM_MAX_TITLE_BYTES,
  PM_MAX_WINNERS,
  PM_MIN_STAKE_USDC_BASE_UNITS,
  SEND_USDC_MAX_PER_OP_BASE_UNITS,
} from './aa-constants';
import {
  PM_CREATE_MARKET_ABI,
  PM_CREATE_MARKET_SELECTOR,
  type PmCreateParamsTuple,
} from './private-markets/abi-fragments';

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
  | 'bad_multisend_calldata'
  | 'bad_multisend_format'
  | 'bad_subcall_count'
  | 'bad_subcall_op'
  | 'bad_approval_target'
  | 'bad_approval_amount'
  | 'bad_placebet_args'
  // Phase 1E send flow:
  | 'bad_send_args'
  | 'bad_send_recipient'
  | 'bad_send_amount'
  // Phase 1H create-market flow:
  | 'bad_create_args'
  | 'bad_create_question'
  | 'bad_create_timestamps'
  // Phase 2C-1 PM create-market flow:
  | 'pm_bad_create_args'
  | 'pm_bad_create_metadata'
  | 'pm_bad_create_timestamps'
  | 'pm_treasury_not_allowed';

export class NotAllowedError extends Error {
  constructor(
    public readonly reason: NotAllowedReason,
    public readonly detail?: string,
    message?: string,
  ) {
    super(message ?? `aa-call-allowlist: ${reason}${detail ? ` (${detail})` : ''}`);
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

/// `createMarket(uint8, bytes32, uint64, uint64, string)`. Phase 1H
/// create-market flow. Mirrors v4 contract method exactly. The mType
/// argument is a uint8 enum mapped to MarketType {FOOTBALL=0, CRYPTO=1,
/// BASKETBALL=2} (matches MakoMarketsV4.sol enum order).
const CREATEMARKET_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      { name: 'mType', type: 'uint8' },
      { name: 'oracleRef', type: 'bytes32' },
      { name: 'bettingCloseTime', type: 'uint64' },
      { name: 'closeTime', type: 'uint64' },
      { name: 'question', type: 'string' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

/// 4-byte selectors for the MAKO send-side dispatch. Pinned as literal
/// constants so a future ABI typo cannot silently change what gets
/// routed where. The aa-call-allowlist-selectors.test.ts soft-asserts
/// each constant matches `viem.toFunctionSelector(signature)`; CI
/// fails on drift.
export const PLACEBET_SELECTOR = '0x1a38cac6' as const;
export const CREATEMARKET_SELECTOR = '0xda6a7338' as const;

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

/// MultiSendCallOnly v1.4.1 — single function `multiSend(bytes
/// transactions)`. Selector 0x8d80ff0a. Mirror of the snippet in
/// user-op.ts; both must agree.
///
/// On the send-side (operation === 1), the wrapper's `data` is the
/// CALL data Safe will delegatecall MultiSendCallOnly with. We must
/// decode it as `multiSend(bytes)` BEFORE feeding the inner bytes
/// to parseMultiSendBytes — without this, raw packed tuples that
/// happen to start with op=0x00 would silently look like valid
/// MultiSend bytes to our parser while the on-chain delegatecall
/// would revert (no matching selector → empty fallback → revert).
const MULTISEND_CALL_ONLY_ABI = [
  {
    type: 'function',
    name: 'multiSend',
    inputs: [{ name: 'transactions', type: 'bytes' }],
    outputs: [],
    stateMutability: 'payable',
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

// ── Send-USDC validator (Phase 1E /profile send flow) ──────────────────────

/// Decode `transfer(recipient, amount)` and assert the send-USDC invariants.
/// Used by:
///   - assertSendUsdcCall      (sponsor-time, kind='send_usdc')
///   - assertSponsoredCallData (send-time, op=0 dispatch when wrapper.to is
///                              USDC and the inner shape isn't the
///                              smoke-flow's transfer-to-self)
function decodeAndAssertSendUsdc(args: {
  call: { to: Address; value: bigint; data: Hex };
  safeAddress: Address;
}): void {
  if (args.call.to.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_send_args');
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
      throw new NotAllowedError('bad_send_args');
    }
    decoded = result as unknown as { args: readonly [Address, bigint] };
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_send_args');
  }

  const [recipient, amount] = decoded.args;

  // Recipient invariants. The order matters for operator-log clarity:
  // self-send first (most likely user error — paste own address),
  // then known-protocol-contract destinations (USDC + MAKO catch the
  // "I pasted the contract by mistake" footgun). All map to
  // bad_send_recipient so the UI can show one consistent error.
  if (recipient.toLowerCase() === args.safeAddress.toLowerCase()) {
    throw new NotAllowedError('bad_send_recipient');
  }
  if (recipient.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_send_recipient');
  }
  if (recipient.toLowerCase() === MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_send_recipient');
  }

  // Amount invariants. amount > 0 (zero-amount is a no-op that still
  // burns sponsorship budget). amount <= per-op cap (defense in depth
  // alongside the daily aa_sponsor_limits cap).
  if (amount <= 0n) {
    throw new NotAllowedError('bad_send_amount');
  }
  if (amount > SEND_USDC_MAX_PER_OP_BASE_UNITS) {
    throw new NotAllowedError('bad_send_amount');
  }
}

/// Validate a single `USDC.transfer(recipient, amount)` call from the Safe
/// to an arbitrary recipient (sponsor-time, kind='send_usdc'). Used by
/// /api/aa/sponsor for the Phase 1E /profile send flow.
///
/// Distinct from `assertSponsorableCall` (smoke flow), which only allows
/// transfers to the user's OWN safe with amount in {0n, 1n}. The send
/// flow rejects exactly those self-transfers and accepts arbitrary
/// recipients within the per-op USDC cap.
export function assertSendUsdcCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_send_args');
  }
  decodeAndAssertSendUsdc({ call: args.call, safeAddress: args.safeAddress });
}

// ── Create-market validators (Phase 1H) ─────────────────────────────────────

/// Tuple shape of the decoded createMarket args. Shared by sponsor-time
/// (with chain-time check) and send-time (shape-only) validators.
type CreateMarketArgs = readonly [
  number,    // mType (uint8 enum)
  Hex,       // oracleRef (bytes32)
  bigint,    // bettingCloseTime (uint64)
  bigint,    // closeTime (uint64)
  string,    // question
];

/// Decode + structural assertions shared between sponsor-time and
/// send-time. Validates:
///   - call.to === MAKO_ADDRESS (case-insensitive)
///   - call.value === 0n
///   - call.data ABI-decodes as createMarket
///   - mType ∈ {0, 1, 2}
///   - question UTF-8 byte length ∈ [1, 200]
///   - bettingCloseTime <= closeTime (immutable shape — true at any
///     point in time, NOT clock-relative)
///
/// Does NOT check `closeTime > nowSec`, MIN_DURATION, or MAX_DURATION;
/// those are clock-relative and live only in the sponsor-time wrapper
/// (see `decodeAndAssertCreateMarket`). Send-time uses this shape-only
/// helper directly so legitimate-but-slow Magic-signing users don't
/// get their already-sponsored row 403'd at send time (drift is caught
/// by SafeOp hash recomputation, Guard A in /api/aa/send).
function decodeCreateMarketArgs(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): CreateMarketArgs {
  if (call.to.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_create_args', 'wrong_target');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }

  let decoded: { functionName: 'createMarket'; args: CreateMarketArgs };
  try {
    const result = decodeFunctionData({
      abi: CREATEMARKET_ABI,
      data: call.data,
    });
    if (result.functionName !== 'createMarket') {
      throw new NotAllowedError('bad_create_args', 'wrong_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_create_args', 'decode_failed');
  }

  const [mType, , bettingCloseTime, closeTime, question] = decoded.args;

  if (!(mType === 0 || mType === 1 || mType === 2)) {
    throw new NotAllowedError('bad_create_args', 'bad_mtype_enum');
  }

  // UTF-8 byte length, NOT character count. The contract's qLen check
  // is `bytes(question).length`, so we mirror byte-length semantics.
  // TextEncoder is available in Node ≥ 11 + browsers; aa-call-allowlist
  // is server-only via the route's import, so this is safe.
  const qBytes = new TextEncoder().encode(question).length;
  if (qBytes < 1 || qBytes > CREATE_MARKET_QUESTION_MAX_BYTES) {
    throw new NotAllowedError('bad_create_question');
  }

  // Immutable timestamp shape: bettingCloseTime <= closeTime. NOT a
  // clock-relative invariant — true at any point in time.
  if (bettingCloseTime > closeTime) {
    throw new NotAllowedError('bad_create_timestamps', 'betting_after_close');
  }

  return decoded.args;
}

/// Sponsor-time wrapper: shape checks via decodeCreateMarketArgs PLUS
/// chain-time clock checks. `nowSec` MUST be the latest Monad block
/// timestamp (read by the sponsor route from getAaPublicClient.getBlock,
/// not Date.now()).
function decodeAndAssertCreateMarket(args: {
  call: { to: Address; value: bigint; data: Hex };
  nowSec: bigint;
}): void {
  const [, , bettingCloseTime, closeTime] = decodeCreateMarketArgs(args.call);

  if (!(bettingCloseTime > args.nowSec)) {
    throw new NotAllowedError(
      'bad_create_timestamps',
      'betting_close_in_past',
    );
  }
  if (!(closeTime > args.nowSec)) {
    throw new NotAllowedError('bad_create_timestamps', 'close_in_past');
  }

  const duration = closeTime - args.nowSec;

  // Asymmetric server buffer (30s) sits BELOW the UI's 60s landing
  // buffer so the 5-minute crypto preset is robust against the typical
  // network/RPC delta. Adding the server buffer to MIN_DURATION here
  // means the route accepts only durations that will still pass the
  // contract's own `duration < MIN_DURATION` check at the moment of
  // Pimlico simulation, even if a few blocks pass between snapshot
  // and simulation. Equal buffers are flaky; do NOT change this to 60.
  if (duration < MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC) {
    throw new NotAllowedError('bad_create_timestamps', 'duration_too_short');
  }
  // No max-side slack: time advances between snapshot and simulation,
  // so any positive +slack would let through ops that revert at the
  // contract's `duration > MAX_DURATION` check.
  if (duration > MAKO_V4_MAX_DURATION_SEC) {
    throw new NotAllowedError('bad_create_timestamps', 'duration_too_long');
  }
}

/// Send-time wrapper: shape checks ONLY. No clock checks. Used by
/// `assertSponsoredCallData` MAKO selector dispatch when the inner
/// selector is `createMarket`. Drift in clock-relative timestamps
/// is caught by Guard A (SafeOp hash recomputation) before the
/// bundler is reached; this validator's job is shape-only.
function decodeAndAssertCreateMarketShape(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  decodeCreateMarketArgs(call);
}

/// Validate a single `MakoMarketsV4.createMarket(...)` call (sponsor-time,
/// kind='create_market'). Used by /api/aa/sponsor for the Phase 1H Magic
/// create-market flow.
export function assertCreateMarketCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
  /// Latest Monad block timestamp. The sponsor route reads this once via
  /// getAaPublicClient(chainId).getBlock({ blockTag: 'latest' }) before
  /// invoking the validator. Browser Date.now() is NOT trusted.
  nowSec: bigint;
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  decodeAndAssertCreateMarket({ call: args.call, nowSec: args.nowSec });
}

/// Cheap shape-only validation — no clock, no chain RPC. Round-8 MINOR 1:
/// the sponsor route runs this BEFORE the `getBlock` call so a malicious
/// or misconfigured caller can't force the route to do an RPC roundtrip
/// for a request that would always reject on shape. Same shape checks
/// the full validator does (chainId, target, value, decode, mType,
/// question, immutable bettingCloseTime <= closeTime); skips the
/// clock-relative checks. Suitable for both pre-flight gating AND
/// send-time re-validation.
export function assertCreateMarketShape(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  decodeAndAssertCreateMarketShape(args.call);
}

// ── Private-markets create-market validators (Phase 2C-1) ──────────────────
//
// Three-stage sync validator split so the sponsor route can pre-flight a
// cheap shape check BEFORE doing RPC roundtrips for treasury / nowSec
// (Codex r3 MIN-1 deferral pattern, mirrored from the v4 create flow):
//
//   Stage 1 — assertPmCreateMarketShapeNoTreasury
//     Pure decode + structural / numeric / byte bounds.
//     Includes the IMMUTABLE clock-independent invariant
//     `closeAt > stakingOpensAt`. NO RPC, NO DB, NO treasury, NO nowSec.
//     Used as the pre-flight gate so a malformed caller can't force the
//     route into a treasury read + getBlock roundtrip.
//
//   Stage 2 — assertPmCreateMarketShape (= Stage 1 + treasury exclusion)
//     Adds participant.treasury + allowlist.treasury exclusion.
//     Used at SEND-TIME (after the sponsor route's clock check has
//     already cleared the bundler-accept path; clock drift is caught by
//     Guard A in /api/aa/send via SafeOp hash recomputation).
//
//   Stage 3 — assertPmCreateMarketCall (= Stage 1 + 2 + clock)
//     Adds the CLOCK-RELATIVE invariant `stakingOpensAt >= nowSec`.
//     Sponsor-time only. `nowSec` MUST be the latest Monad block
//     timestamp (read by the sponsor route from getAaPublicClient
//     .getBlock, not Date.now()).
//
// All three return `void` (sync). Throws `NotAllowedError` on any failure.
// Reason codes: pm_bad_create_args (target/value/decode/enum/winners/stake
// bounds/options/participants/allowlist), pm_bad_create_metadata (title /
// description / streamUrl / option-label byte sizes), pm_bad_create_timestamps
// (immutable shape + clock), pm_treasury_not_allowed (Stage 2 only).
//
// Mirror of MakoPrivateMarketsV1.sol::_validateCreate (lines 475-554).
// Every check in the contract appears here. The contract is the source of
// truth — drift caught by `aa-call-allowlist-pm.test.ts` boundary cases.
// ----------------------------------------------------------------------------

const PM_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/// Internal helper. Validates Stage 1 invariants on the decoded params.
/// No treasury, no clock. Throws NotAllowedError on any failure.
function _assertPmCreateMarketSemanticsNoTreasury(p: PmCreateParamsTuple): void {
  // Shape enum (uint8): contract has MarketShape { Friendly=0, OpenVote=1,
  // PrizePool=2 }. The TS literal type already constrains to {0,1,2} but
  // we re-check defensively in case a malicious caller bypasses the
  // typescript-level guard.
  if (p.shape !== 0 && p.shape !== 1 && p.shape !== 2) {
    throw new NotAllowedError('pm_bad_create_args', 'bad_shape_enum');
  }

  // Visibility enums (uint8). VisibilityView { LinkOnly=0, Public=1 } and
  // VisibilityParticipation { Open=0, Allowlisted=1 }.
  if (p.viewMode !== 0 && p.viewMode !== 1) {
    throw new NotAllowedError('pm_bad_create_args', 'bad_view_enum');
  }
  if (p.participationMode !== 0 && p.participationMode !== 1) {
    throw new NotAllowedError('pm_bad_create_args', 'bad_participation_enum');
  }

  // Immutable timestamp shape: closeAt > stakingOpensAt. NOT clock-
  // relative — true at any point in time. Lives in Stage 1 so BOTH
  // sponsor-time AND send-time enforce it (Codex r4 MAJ-3 fix; the
  // clock-relative `stakingOpensAt >= nowSec` is Stage 3 only).
  if (p.closeAt <= p.stakingOpensAt) {
    throw new NotAllowedError(
      'pm_bad_create_timestamps',
      'close_at_le_staking',
    );
  }

  // ── Metadata byte sizes (mirror MakoPrivateMarketsV1.sol:481-483) ────
  // title.length: bytes is a hex string `0x...`, so byte count is
  // (length - 2) / 2. Same for description and streamUrl.
  const titleBytes = hexByteLength(p.title);
  if (titleBytes === 0 || titleBytes > PM_MAX_TITLE_BYTES) {
    throw new NotAllowedError(
      'pm_bad_create_metadata',
      titleBytes === 0 ? 'title_empty' : 'title_too_long',
    );
  }

  const descriptionBytes = hexByteLength(p.description);
  if (descriptionBytes > PM_MAX_DESCRIPTION_BYTES) {
    throw new NotAllowedError(
      'pm_bad_create_metadata',
      'description_too_long',
    );
  }

  const streamUrlBytes = hexByteLength(p.streamUrl);
  if (streamUrlBytes > PM_MAX_STREAM_URL_BYTES) {
    throw new NotAllowedError(
      'pm_bad_create_metadata',
      'stream_url_too_long',
    );
  }

  // ── Options (mirror :486-496) ────────────────────────────────────────
  if (p.shape === 0) {
    // Friendly: binary, exactly 2 option labels.
    if (p.optionLabels.length !== 2) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'friendly_options_must_be_2',
      );
    }
  } else {
    if (p.optionLabels.length < 2) {
      throw new NotAllowedError('pm_bad_create_args', 'options_too_few');
    }
    if (p.optionLabels.length > PM_MAX_OPTIONS) {
      throw new NotAllowedError('pm_bad_create_args', 'options_too_many');
    }
  }
  for (let i = 0; i < p.optionLabels.length; i++) {
    const labelBytes = hexByteLength(p.optionLabels[i]);
    if (labelBytes === 0 || labelBytes > PM_MAX_OPTION_LABEL_BYTES) {
      throw new NotAllowedError(
        'pm_bad_create_metadata',
        labelBytes === 0 ? 'option_label_empty' : 'option_label_too_long',
      );
    }
  }

  // ── Stake bounds (mirror :499-516) ───────────────────────────────────
  if (p.perStakeMin !== 0n && p.perStakeMin < PM_MIN_STAKE_USDC_BASE_UNITS) {
    throw new NotAllowedError(
      'pm_bad_create_args',
      'per_stake_min_below_floor',
    );
  }
  const effectiveMin =
    p.perStakeMin === 0n ? PM_MIN_STAKE_USDC_BASE_UNITS : p.perStakeMin;
  if (p.perStakeMax !== 0n && p.perStakeMax < effectiveMin) {
    throw new NotAllowedError(
      'pm_bad_create_args',
      'per_stake_max_below_min',
    );
  }

  if (p.shape === 1) {
    // OpenVote
    if (p.fixedStake < PM_MIN_STAKE_USDC_BASE_UNITS) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'open_vote_fixed_stake_below_floor',
      );
    }
    if (
      p.perStakeMin !== 0n ||
      p.perStakeMax !== 0n ||
      p.perWalletCumulativeMax !== 0n
    ) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'open_vote_per_stake_must_be_zero',
      );
    }
  } else if (p.shape === 0) {
    // Friendly
    if (p.fixedStake !== 0n) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'friendly_fixed_stake_must_be_zero',
      );
    }
    if (p.perWalletCumulativeMax !== 0n) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'friendly_per_wallet_cum_must_be_zero',
      );
    }
  } else {
    // PrizePool
    if (p.fixedStake !== 0n) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'prize_pool_fixed_stake_must_be_zero',
      );
    }
  }

  // ── Winners (mirror :518-523) ────────────────────────────────────────
  if (p.shape === 0) {
    if (p.winnersCount !== 0) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'friendly_winners_must_be_zero',
      );
    }
  } else {
    if (p.winnersCount === 0) {
      throw new NotAllowedError('pm_bad_create_args', 'winners_zero');
    }
    if (p.winnersCount > PM_MAX_WINNERS) {
      throw new NotAllowedError('pm_bad_create_args', 'winners_too_many');
    }
    if (p.winnersCount > p.optionLabels.length) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'winners_exceeds_options',
      );
    }
  }

  // ── Participants (mirror :526-538) ───────────────────────────────────
  if (p.shape === 2) {
    // PrizePool: participantWallets.length == optionLabels.length, no
    // zero address, no duplicates. Treasury check is Stage 2.
    if (p.participantWallets.length !== p.optionLabels.length) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'participants_count_mismatch',
      );
    }
    const seen = new Set<string>();
    for (let i = 0; i < p.participantWallets.length; i++) {
      const w = p.participantWallets[i].toLowerCase();
      if (w === PM_ZERO_ADDRESS) {
        throw new NotAllowedError(
          'pm_bad_create_args',
          'participants_zero_address',
        );
      }
      if (seen.has(w)) {
        throw new NotAllowedError(
          'pm_bad_create_args',
          'participants_duplicate',
        );
      }
      seen.add(w);
    }
  } else {
    if (p.participantWallets.length !== 0) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'participants_must_be_empty',
      );
    }
  }

  // ── Allowlist (mirror :541-553) ──────────────────────────────────────
  if (p.participationMode === 1) {
    // Allowlisted
    if (p.allowlist.length === 0) {
      throw new NotAllowedError('pm_bad_create_args', 'allowlist_empty');
    }
    if (p.allowlist.length > PM_MAX_ALLOWLIST) {
      throw new NotAllowedError('pm_bad_create_args', 'allowlist_too_many');
    }
    const seen = new Set<string>();
    for (let i = 0; i < p.allowlist.length; i++) {
      const a = p.allowlist[i].toLowerCase();
      if (a === PM_ZERO_ADDRESS) {
        throw new NotAllowedError(
          'pm_bad_create_args',
          'allowlist_zero_address',
        );
      }
      if (seen.has(a)) {
        throw new NotAllowedError(
          'pm_bad_create_args',
          'allowlist_duplicate',
        );
      }
      seen.add(a);
    }
  } else {
    if (p.allowlist.length !== 0) {
      throw new NotAllowedError(
        'pm_bad_create_args',
        'allowlist_must_be_empty',
      );
    }
  }
}

/// Internal helper. Validates Stage 2 — treasury exclusion in participants
/// + allowlist. Pure sync. Treasury comparison case-insensitive.
function _assertPmCreateMarketTreasuryExclusion(
  p: PmCreateParamsTuple,
  treasury: Address,
): void {
  const t = treasury.toLowerCase();
  if (p.shape === 2) {
    for (let i = 0; i < p.participantWallets.length; i++) {
      if (p.participantWallets[i].toLowerCase() === t) {
        throw new NotAllowedError(
          'pm_treasury_not_allowed',
          'participant_is_treasury',
        );
      }
    }
  }
  if (p.participationMode === 1) {
    for (let i = 0; i < p.allowlist.length; i++) {
      if (p.allowlist[i].toLowerCase() === t) {
        throw new NotAllowedError(
          'pm_treasury_not_allowed',
          'allowlist_is_treasury',
        );
      }
    }
  }
}

/// Internal helper. Validates Stage 3 — clock-relative timestamp check.
/// `stakingOpensAt >= nowSec`. The contract uses strict `<` so the
/// equal-second boundary is ACCEPTED (Codex r3 boundary case).
function _assertPmCreateMarketTimestamps(
  p: PmCreateParamsTuple,
  nowSec: bigint,
): void {
  if (p.stakingOpensAt < nowSec) {
    throw new NotAllowedError(
      'pm_bad_create_timestamps',
      'staking_opens_in_past',
    );
  }
}

/// Decode the wrapped call and run the chainId + target + value + selector
/// gates that precede the shape semantics. Shared by all three entry
/// points. Returns the typed params tuple.
function _decodePmCreateMarketCall(
  chainId: number,
  call: { to: Address; value: bigint; data: Hex },
): PmCreateParamsTuple {
  if (chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('pm_bad_create_args', 'wrong_chain');
  }
  if (call.to.toLowerCase() !== PM_CONTRACT_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('pm_bad_create_args', 'wrong_target');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('pm_bad_create_args', 'bad_value');
  }
  if (call.data.length < 10) {
    throw new NotAllowedError('pm_bad_create_args', 'short_calldata');
  }
  if (call.data.slice(0, 10).toLowerCase() !== PM_CREATE_MARKET_SELECTOR) {
    throw new NotAllowedError('pm_bad_create_args', 'wrong_selector');
  }

  let decoded: {
    functionName: 'createMarket';
    args: readonly [PmCreateParamsTuple];
  };
  try {
    const result = decodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      data: call.data,
    });
    if (result.functionName !== 'createMarket') {
      throw new NotAllowedError('pm_bad_create_args', 'wrong_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('pm_bad_create_args', 'decode_failed');
  }

  return decoded.args[0];
}

/// Byte length of a `bytes`/`bytes[]` hex string. `0x` prefix stripped;
/// the remaining chars are 2 per byte. ABI decode never produces an
/// odd-length payload for `bytes`; if one shows up it indicates a
/// corrupted / bug-decoded value, so panic via a typed error rather
/// than return a sentinel that downstream `<= max` callers would
/// silently let through (Codex 2C-1 step-7 r1 MIN-2).
function hexByteLength(hex: Hex): number {
  if (!hex.startsWith('0x')) {
    throw new NotAllowedError('pm_bad_create_metadata', 'malformed_bytes_hex');
  }
  const hexChars = hex.length - 2;
  if (hexChars % 2 !== 0) {
    throw new NotAllowedError('pm_bad_create_metadata', 'malformed_bytes_hex');
  }
  return hexChars / 2;
}

/// Stage 1 entry point — cheap shape check. NO treasury, NO clock, NO
/// RPC. Suitable for pre-flight gating in the sponsor route before
/// roundtripping to getBlock + getPmTreasuryAddress.
export function assertPmCreateMarketShapeNoTreasury(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  const params = _decodePmCreateMarketCall(args.chainId, args.call);
  _assertPmCreateMarketSemanticsNoTreasury(params);
}

/// Stage 1 + 2 entry point — shape + treasury exclusion. NO clock.
/// Used at SEND-TIME for defense-in-depth after the sponsor route has
/// already validated the call shape. Treasury must be passed in by the
/// caller (await getPmTreasuryAddress at the caller).
export function assertPmCreateMarketShape(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
  treasury: Address;
}): void {
  const params = _decodePmCreateMarketCall(args.chainId, args.call);
  _assertPmCreateMarketSemanticsNoTreasury(params);
  _assertPmCreateMarketTreasuryExclusion(params, args.treasury);
}

/// Stage 1 + 2 + 3 entry point — full validator with clock. Sponsor-time
/// only. `nowSec` must be the latest Monad block timestamp, NOT
/// Date.now(). Treasury must be passed in by the caller.
export function assertPmCreateMarketCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
  treasury: Address;
  nowSec: bigint;
}): void {
  const params = _decodePmCreateMarketCall(args.chainId, args.call);
  _assertPmCreateMarketSemanticsNoTreasury(params);
  _assertPmCreateMarketTreasuryExclusion(params, args.treasury);
  _assertPmCreateMarketTimestamps(params, args.nowSec);
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
    // CALL — single inner call. Three flows can produce op=0:
    //   smoke      → USDC.transfer(self, 0n|1n)        (assertSponsorableCall)
    //   bet_single → MakoMarketsV4.placeBet(...)       (decodeAndAssertPlaceBet)
    //   send_usdc  → USDC.transfer(arbitraryRecipient, amount)  (assertSendUsdcCall)
    //
    // Dispatch by wrapper.to first, then for the USDC case dispatch by
    // inner `transfer.recipient` — smoke ALWAYS sends to self; send_usdc
    // ALWAYS sends to a non-self recipient. The two validators are
    // orthogonal in what they accept, so a deterministic dispatch on
    // `recipient === safeAddress` is sufficient. Both validators
    // independently re-check value, selector, and bounds.
    if (to.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
      // Inner-call decode happens once here to discriminate. The chosen
      // validator decodes again — this duplicates ~1 microsecond of
      // ABI parsing in exchange for keeping each validator's invariants
      // self-contained. Cheap and operationally clearer.
      let dispatchToSmoke: boolean;
      try {
        const innerDecoded = decodeFunctionData({
          abi: TRANSFER_ABI,
          data,
        });
        if (innerDecoded.functionName !== 'transfer') {
          // Wrong selector; let the smoke validator surface
          // `bad_selector` for consistency with the sponsor route.
          dispatchToSmoke = true;
        } else {
          const [recipient] = innerDecoded.args as readonly [Address, bigint];
          dispatchToSmoke =
            recipient.toLowerCase() === args.safeAddress.toLowerCase();
        }
      } catch {
        // Decode failure → smoke validator will throw bad_selector
        // and surface a coherent reason code.
        dispatchToSmoke = true;
      }

      if (dispatchToSmoke) {
        assertSponsorableCall({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: { to, value, data },
        });
      } else {
        assertSendUsdcCall({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: { to, value, data },
        });
      }
      return;
    }
    if (to.toLowerCase() === MAKO_ADDRESS.toLowerCase()) {
      // Mirror the sponsor-time chainId guard. The send-side validator
      // is meant to defend persisted callData independently of the
      // sponsor route — round-1 MINOR 1 fix.
      if (args.chainId !== MONAD_TESTNET_ID) {
        throw new NotAllowedError('bad_placebet_args');
      }
      // Phase 1H: dispatch by 4-byte selector. placeBet (0x1a38cac6)
      // and createMarket (0xda6a7338) are the two MAKO methods we
      // sponsor today. Selector dispatch — not exception-catch
      // fallthrough — so a malformed placeBet cannot silently remap
      // to bad_create_args (or vice versa).
      if (data.length < 10) {
        throw new NotAllowedError('bad_selector');
      }
      const innerSelector = data.slice(0, 10).toLowerCase();
      if (innerSelector === PLACEBET_SELECTOR) {
        decodeAndAssertPlaceBet({ to, value, data });
        return;
      }
      if (innerSelector === CREATEMARKET_SELECTOR) {
        // Shape-only at send-time. Clock-relative timestamp drift is
        // caught by Guard A (SafeOp hash recomputation) before the
        // bundler is reached.
        decodeAndAssertCreateMarketShape({ to, value, data });
        return;
      }
      throw new NotAllowedError('bad_selector');
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

    // Decode `data` as multiSend(bytes) ABI calldata. This is what
    // MultiSendCallOnly's delegatecall actually dispatches on — see
    // MULTISEND_CALL_ONLY_ABI comment above. Pre-fix, this branch
    // skipped the ABI decode and treated `data` as raw packed
    // tuples directly; that bug caused on-chain
    // ExecutionFailed() (selector 0xacfdb444) because the
    // delegatecall's first 4 bytes never matched a function on
    // MultiSendCallOnly.
    let multiSendInner: Hex;
    try {
      const decodedMs = decodeFunctionData({
        abi: MULTISEND_CALL_ONLY_ABI,
        data,
      });
      if (decodedMs.functionName !== 'multiSend') {
        throw new NotAllowedError('bad_multisend_calldata');
      }
      multiSendInner = (decodedMs.args as readonly [Hex])[0];
    } catch (e) {
      if (e instanceof NotAllowedError) throw e;
      throw new NotAllowedError('bad_multisend_calldata');
    }

    const sub = parseMultiSendBytes(multiSendInner);
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
