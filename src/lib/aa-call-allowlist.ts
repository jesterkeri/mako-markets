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
  hexToString,
  type Address,
  type Hex,
} from 'viem';

import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS } from './contract';
import { PAUSED_CREATE_MTYPES } from './market-availability';
import { PRICE_FEED_BY_SYMBOL } from './price-feed-assets';
import { MONAD_TESTNET_ID } from './chain';
import { SAFE_CONFIG } from './safe-config';
import { USDC_ADDRESS } from './usdc';
import {
  CREATE_MARKET_QUESTION_MAX_BYTES,
  CREATE_MARKET_MIN_SERVER_BUFFER_SEC,
  MAKO_ADMIN_SAFE_ADDRESS,
  MAKO_V4_MAX_DURATION_SEC,
  MAKO_V4_MIN_DURATION_SEC,
  MIN_CREATOR_SEED_USDC_BASE,
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
  PM_BET_SELECTOR,
  PM_CANCEL_SELECTOR,
  PM_CLAIM_SELECTOR as _PM_CLAIM_SELECTOR_FOR_DISPATCH,
  PM_CONFIRM_SELECTOR,
  PM_CREATE_MARKET_ABI,
  PM_CREATE_MARKET_SELECTOR,
  PM_DISTRIBUTE_SELECTOR,
  PM_EDIT_METADATA_SELECTOR,
  PM_FINALIZE_METADATA_SELECTOR,
  PM_FINALIZE_SELECTOR,
  PM_RESOLVE_SELECTOR,
  PM_STAKE_SELECTOR,
  type PmCreateParamsTuple,
} from './private-markets/abi-fragments';
import { getPmTreasuryAddress } from './private-markets/treasury';
import {
  assertPmBetBatchedCallsShape,
  assertPmBetCallShape,
  assertPmCancelCallShape,
  assertPmClaimCall,
  assertPmConfirmCallShape,
  assertPmDistributeCallShape,
  assertPmEditMetadataCallShape,
  assertPmFinalizeCall,
  assertPmFinalizeMetadataCall,
  assertPmResolveCallShape,
  assertPmStakeBatchedCallsShape,
  assertPmStakeCallShape,
  isPmTarget,
} from './private-markets/pm-call-allowlist';
import { assertRoundsSendBatched, assertRoundsSendCall, isRoundsTarget } from './rounds-call-allowlist';
import { assertRoundsRelease } from './rounds-release';
import { isProtocolRecipient } from './protocol-recipients';

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
  // v4 redeploy (slice 4c) — creator seed + MAKO admin gate + blocklist.
  // Distinct codes so a 403 carries actionable info without forcing
  // operators to parse a `detail` string.
  | 'bad_create_seed_too_small'
  | 'bad_create_mako_nonzero_seed'
  | 'bad_create_mako_non_admin'
  | 'bad_create_mtype_out_of_range'
  // A market type paused in market-availability.ts (no price source can settle it today).
  | 'bad_create_mtype_paused'
  | 'bad_create_blocked_wallet'
  // v4 redeploy (slice 4f): sponsor-time mirror of the contract's
  // CreatorDailyCapExceeded (MAX_CREATES_PER_DAY=10 per UTC day for
  // non-MAKO). Saves a Magic user from burning sponsor budget on an
  // op that would revert at simulation. MAKO is contract-exempt.
  | 'bad_create_daily_cap_exceeded'
  // Codex r1 4e MAJOR 1: MAKO has no creator seed (always 0n), so the
  // batched approve+create path has no business being used for a MAKO
  // create. Rejecting up-front prevents an admin session from granting
  // a MaxUint256 USDC allowance to MAKO via the batched dispatcher
  // (admin uses the single-call path for MAKO).
  | 'bad_create_mako_in_batched_path'
  // #180 price-feed allowlist for FOREX / COMMODITIES / STOCKS
  // (mType 3/4/5). Gate sits inside decodeCreateMarketArgs so every
  // surface (sponsor, send, batched-sponsor, batched-send) inherits.
  | 'bad_create_oracleref_format'
  | 'bad_create_oracleref_unknown_price_feed_symbol'
  | 'bad_create_oracleref_class_mismatch'
  // claim-magic-parity claim flow:
  | 'bad_claim_args'
  // Phase 2C-1 PM create-market flow:
  | 'pm_bad_create_args'
  | 'pm_bad_create_metadata'
  | 'pm_bad_create_timestamps'
  | 'pm_treasury_not_allowed'
  // Phase 2E-1 PM action flows. Granular buckets per action follow the
  // same `<action>_args` + `<action>_<gate>` shape as createMarket so a
  // 403 carries a self-explanatory reason without needing a generic
  // bucket. Plus three chain-state buckets from the multicall hydration
  // path (sponsor-chain-state.ts):
  //   - pm_state_rpc_failure       transport-level multicall throw
  //   - pm_bad_state_shape_unknown view decoded but shape/state out of
  //                                range, or side-view per-call failure
  //                                while getMarket succeeded
  //   - pm_market_not_found        getMarket per-call failure (only
  //                                realistic revert is MarketUnknown)
  // bet (Friendly only) — _stakeCommon gates share semantics with stake.
  | 'pm_bad_bet_args'
  // stake (OpenVote / PrizePool) — Stage A-G in pm-call-allowlist.ts.
  | 'pm_bad_stake_args'
  | 'pm_bad_stake_treasury'
  | 'pm_bad_stake_state'
  | 'pm_bad_stake_time'
  | 'pm_bad_stake_allowlist'
  | 'pm_bad_stake_bounds'
  // claim (anyone) — PM-specific so v4's `bad_claim_args` isn't reused.
  | 'pm_bad_claim_args'
  // finalize / finalizeMetadata (anyone-can-call, idempotent).
  | 'pm_bad_finalize_args'
  | 'pm_bad_finalize_metadata_args'
  // Creator-action validators (resolve / confirm / distribute / cancel).
  | 'pm_bad_creator_action_args'
  | 'pm_bad_creator_action_not_creator'
  | 'pm_bad_creator_action_window'
  | 'pm_bad_creator_action_state'
  | 'pm_bad_creator_action_empty_pool'
  | 'pm_bad_creator_action_wrong_shape'
  // editMetadata (creator-only, pre-stakingOpensAt only).
  | 'pm_bad_edit_args'
  | 'pm_bad_edit_not_creator'
  | 'pm_bad_edit_window_closed'
  | 'pm_bad_edit_shape_mismatch'
  // Chain-state hydration failures (sponsor-chain-state.ts).
  | 'pm_market_not_found'
  | 'pm_state_rpc_failure'
  | 'pm_bad_state_shape_unknown'
  // Rounds (MakoRoundsV1; rounds-call-allowlist.ts). round_unavailable: the Rounds address is unset or collides
  // with another contract, so nothing Rounds is sponsored or sent.
  | 'round_unavailable'
  | 'round_bad_target'
  | 'round_bad_enter_args'
  | 'round_bad_claim_args'
  | 'round_bad_refund_args'
  | 'round_bad_schedule_args'
  | 'round_bad_approval'
  | 'round_not_creator'
  | 'round_state_rpc_failure';

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

/// `createMarket(uint8, bytes32, uint64, uint64, string, uint256, bool)`.
/// Phase 1H create-market flow, extended in the v4 redeploy (slice 4c)
/// with `creatorSeed` + `creatorYes` for the bundled creator-bet seed.
/// Mirrors v4 contract method exactly. The mType argument is a uint8 enum
/// mapped to MarketType {FOOTBALL=0, CRYPTO=1, BASKETBALL=2, FOREX=3,
/// COMMODITIES=4, STOCKS=5, MAKO=6} — must match MakoMarketsV4.sol enum
/// order (append-only). Reordering existing values breaks indexers + AA.
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
      { name: 'creatorSeed', type: 'uint256' },
      { name: 'creatorYes', type: 'bool' },
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
export const CREATEMARKET_SELECTOR = '0xd1aa0ea8' as const;
/// `claim(uint256)` selector. Phase 2 claim-magic-parity. Confirmed
/// via `keccak256(toBytes('claim(uint256)')).slice(0, 10)` at module
/// dev time — pinned as a hex literal so a drift in the ABI fragment
/// can't silently align with the runtime computation.
export const CLAIM_SELECTOR = '0x379607f5' as const;

/// ABI fragment for `claim(uint256)`. Minimal — used only to
/// decode the inner call at sponsor- + send-time. Source of truth
/// is `MakoMarketsV4.sol`'s `function claim(uint256 id) external`.
const CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'id', type: 'uint256' }],
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
  // then Mako Market's own contracts and USDC, from the one list the /wallet
  // form also uses (src/lib/protocol-recipients.ts; Codex batch r1 F1: the
  // page refused Private Markets and the server did not). All map to
  // bad_send_recipient so the UI can show one consistent error.
  if (recipient.toLowerCase() === args.safeAddress.toLowerCase()) {
    throw new NotAllowedError('bad_send_recipient');
  }
  if (isProtocolRecipient(recipient)) {
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

// ── Claim validators (claim-magic-parity) ───────────────────────────────────

/// Decode + structural assertions for `claim(uint256)`. Shared by
/// sponsor-time and send-time. Validates:
///   - call.to === MAKO_ADDRESS
///   - call.value === 0n
///   - call.data ABI-decodes as `claim(uint256)`
///   - decoded `id` is a non-negative uint256 (viem already gates the
///     range; the assertion is explicit defense-in-depth)
///
/// No clock-relative checks: a claim is valid any time after the
/// market is resolved, and the contract enforces the "must be
/// resolved" + "must have a position" + "must not have claimed" rules
/// on-chain. The allowlist's job is to reject anything that isn't
/// shape-correct `claim(uint256)` — defense-in-depth against a
/// malicious caller forging a different inner call inside an
/// allowlisted wrapper.
function decodeAndAssertClaim(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  if (call.to.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_claim_args', 'wrong_target');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }
  let decoded: { functionName: 'claim'; args: readonly [bigint] };
  try {
    const result = decodeFunctionData({ abi: CLAIM_ABI, data: call.data });
    if (result.functionName !== 'claim') {
      throw new NotAllowedError('bad_claim_args', 'wrong_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_claim_args', 'decode_failed');
  }
  const [id] = decoded.args;
  if (id < 0n) {
    throw new NotAllowedError('bad_claim_args', 'bad_market_id');
  }
}

/// Validate a single `MakoMarketsV4.claim(id)` call from the Safe
/// (sponsor-time, kind='claim'). Used by /api/aa/sponsor for the
/// Magic-flow claim path. No clock-relative checks — the contract
/// enforces resolution + position + has-not-claimed.
export function assertClaimCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_claim_args', 'wrong_chain');
  }
  decodeAndAssertClaim(args.call);
}

/// Send-time shape-only check for `claim(uint256)`. Mirrors
/// `decodeAndAssertCreateMarketShape` — re-validates the persisted
/// callData independently of the sponsor route. No state, no clock.
export function decodeAndAssertClaimShape(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  decodeAndAssertClaim(call);
}

// ── Create-market validators (Phase 1H) ─────────────────────────────────────

/// Result of parsing a price-feed oracleRef (FOREX / COMMODITIES /
/// STOCKS). Tagged-union so the caller can surface the specific
/// NotAllowedReason code rather than collapsing everything into a
/// generic "bad oracleRef". Local to this module; cf-worker has its
/// own mirror parser for resolution (chunk C of #180).
type PriceFeedOracleRefResult =
  | { kind: 'ok'; symbol: string; op: 'gt' | 'lt'; strike: number }
  | { kind: 'bad_format' }
  | { kind: 'unknown_symbol'; symbol: string }
  | { kind: 'class_mismatch'; symbol: string; actualClass: 'forex' | 'commodities' | 'stocks' };

/// Parse a bytes32 oracleRef as `SYMBOL:gt|lt:STRIKE` against the
/// price-feed allowlist. Format mirrors CRYPTO oracleRef (the
/// auto-resolver uses the same SYMBOL:op:STRIKE shape) but with the
/// symbol drawn from PRICE_FEED_BY_SYMBOL and an `expectedClass`
/// gate so a FOREX mType can't carry a STOCKS symbol.
///
/// Returns a tagged union so the caller can map each failure mode to
/// a distinct NotAllowedReason. Production caller is
/// `decodeCreateMarketArgs` (#180 chunk B).
function parsePriceFeedOracleRef(
  ref: Hex,
  expectedClass: 'forex' | 'commodities' | 'stocks',
): PriceFeedOracleRefResult {
  // Decode the 32-byte slot to a UTF-8 string, trim trailing nulls.
  // Mirrors cf-worker/src/index.ts decodeOracleRefString. The
  // try/catch protects against malformed hex (impossible here since
  // viem already decoded the bytes32, but defensive).
  let decoded: string;
  try {
    decoded = hexToString(ref, { size: 32 }).replace(/\0+$/, '').trim();
  } catch {
    return { kind: 'bad_format' };
  }
  if (decoded.length === 0) return { kind: 'bad_format' };

  const parts = decoded.split(':');
  if (parts.length !== 3) return { kind: 'bad_format' };
  const [symbolPart, opPart, strikePart] = parts.map((p) => p.trim());

  if (opPart !== 'gt' && opPart !== 'lt') return { kind: 'bad_format' };

  // Allow leading +, integer or decimal, must be finite and positive.
  // Strict regex AFTER trimming so a trailing-junk symbol doesn't slip
  // through Number()'s coercion (e.g., "1.0850abc" would parse to NaN
  // but a permissive caller could be surprised).
  if (!/^\+?(\d+\.\d+|\d+|\.\d+)$/.test(strikePart)) {
    return { kind: 'bad_format' };
  }
  const strike = Number(strikePart);
  if (!Number.isFinite(strike) || strike <= 0) return { kind: 'bad_format' };

  const asset = PRICE_FEED_BY_SYMBOL.get(symbolPart);
  if (!asset) return { kind: 'unknown_symbol', symbol: symbolPart };
  if (asset.class !== expectedClass) {
    return {
      kind: 'class_mismatch',
      symbol: symbolPart,
      actualClass: asset.class,
    };
  }

  return { kind: 'ok', symbol: symbolPart, op: opPart, strike };
}

/// Tuple shape of the decoded createMarket args. Shared by sponsor-time
/// (with chain-time check) and send-time (shape-only) validators.
/// v4 redeploy (slice 4c) appended creatorSeed (uint256) and creatorYes
/// (bool) at the end.
type CreateMarketArgs = readonly [
  number,    // mType (uint8 enum, 0..6)
  Hex,       // oracleRef (bytes32)
  bigint,    // bettingCloseTime (uint64)
  bigint,    // closeTime (uint64)
  string,    // question
  bigint,    // creatorSeed (uint256, USDC base units)
  boolean,   // creatorYes
];

/// Decode + structural assertions shared between sponsor-time and
/// send-time. Validates:
///   - call.to === MAKO_ADDRESS (case-insensitive)
///   - call.value === 0n
///   - call.data ABI-decodes as createMarket
///   - mType ∈ {0..6} (v4 enum: FOOTBALL, CRYPTO, BASKETBALL, FOREX,
///     COMMODITIES, STOCKS, MAKO)
///   - oracleRef on mType ∈ {3, 4, 5} matches the price-feed
///     allowlist + class-match (#180)
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

  // Selector check BEFORE decode (codex r5 M-1). Wrong-selector data
  // must not reach decodeFunctionData where viem may throw a raw
  // ABIDecodingError that escapes the route discipline.
  if (call.data.slice(0, 10).toLowerCase() !== CREATEMARKET_SELECTOR) {
    throw new NotAllowedError('bad_create_args', 'wrong_selector');
  }

  // Decode wrapped in try/catch. Truncated or otherwise-malformed
  // calldata that survived the 4-byte selector check (e.g. attacker
  // pads selector with garbage args) resolves to a NotAllowed reason
  // instead of a raw viem ABI throw. Same documented failure mode.
  let decoded: { functionName: 'createMarket'; args: CreateMarketArgs };
  try {
    const result = decodeFunctionData({
      abi: CREATEMARKET_ABI,
      data: call.data,
    });
    if (result.functionName !== 'createMarket') {
      // Defensive: should be unreachable given the selector check above.
      throw new NotAllowedError('bad_create_args', 'wrong_selector');
    }
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_create_args', 'decode_failed');
  }

  const [mType, oracleRef, bettingCloseTime, closeTime, question, creatorSeed] =
    decoded.args;

  // mType 0..6 — the v4 redeploy widened the enum (FOREX, COMMODITIES,
  // STOCKS, MAKO). Reject anything outside the contract's enum range
  // with a distinct reason so a stale frontend bundle's mType=99 doesn't
  // get a vague rejection.
  if (mType < 0 || mType > 6 || !Number.isInteger(mType)) {
    throw new NotAllowedError('bad_create_mtype_out_of_range');
  }
  // A type whose pools cannot be settled on a price today is not created at all (market-availability.ts): the page
  // shows it as Coming soon, and this refuses it for every surface that decodes a create (sponsor, send, batched).
  if (PAUSED_CREATE_MTYPES.has(mType)) {
    throw new NotAllowedError('bad_create_mtype_paused');
  }

  // #180: price-feed allowlist + class-match gate. Single insertion
  // point inside the shared decode helper so every surface (sponsor,
  // send, batched-sponsor, batched-send) inherits the check via the
  // existing decodeCreateMarketArgs call. Clock-independent shape
  // check — runs in the send-time validators too. CRYPTO (mType=1),
  // FOOTBALL (0), BASKETBALL (2), MAKO (6) keep their existing
  // oracleRef semantics unchanged (no symbol/class gate for those
  // types here; defense-in-depth tightening tracked separately).
  if (mType === 3 || mType === 4 || mType === 5) {
    const expectedClass: 'forex' | 'commodities' | 'stocks' =
      mType === 3 ? 'forex' : mType === 4 ? 'commodities' : 'stocks';
    const result = parsePriceFeedOracleRef(oracleRef, expectedClass);
    if (result.kind === 'bad_format') {
      throw new NotAllowedError('bad_create_oracleref_format');
    }
    if (result.kind === 'unknown_symbol') {
      throw new NotAllowedError(
        'bad_create_oracleref_unknown_price_feed_symbol',
        result.symbol,
      );
    }
    if (result.kind === 'class_mismatch') {
      throw new NotAllowedError(
        'bad_create_oracleref_class_mismatch',
        `${result.symbol} is ${result.actualClass}; mType expects ${expectedClass}`,
      );
    }
    // result.kind === 'ok' — fall through to the rest of the
    // pipeline. The parsed value is not currently used downstream
    // in this validator; it's the cf-worker resolver that needs the
    // symbol/op/strike for outcome derivation.
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

  // Creator seed branch (v4 redeploy). MAKO type must have creatorSeed
  // exactly 0; non-MAKO types must have creatorSeed >= MIN_CREATOR_SEED.
  // The contract enforces both gates; the validator mirrors them so a
  // doomed sponsor is rejected before getBlock + Pimlico round-trip.
  // mType=6 is MAKO (append-only enum; see CREATEMARKET_ABI header).
  const MAKO_MARKET_TYPE = 6;
  if (mType === MAKO_MARKET_TYPE) {
    if (creatorSeed !== 0n) {
      throw new NotAllowedError('bad_create_mako_nonzero_seed');
    }
  } else {
    if (creatorSeed < MIN_CREATOR_SEED_USDC_BASE) {
      throw new NotAllowedError('bad_create_seed_too_small');
    }
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
///
/// MAKO admin gate (slice 4c): MAKO-type markets require the sender's
/// Safe to equal the pinned `MAKO_ADMIN_SAFE_ADDRESS`. The check is
/// static (env-bound at module load) so it lives in the shape variant
/// — no chain read needed. Non-MAKO types skip this branch.
function decodeAndAssertCreateMarketShape(args: {
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  const decoded = decodeCreateMarketArgs(args.call);
  const mType = decoded[0];
  const MAKO_MARKET_TYPE = 6;
  if (mType === MAKO_MARKET_TYPE) {
    if (args.safeAddress.toLowerCase() !== MAKO_ADMIN_SAFE_ADDRESS) {
      throw new NotAllowedError('bad_create_mako_non_admin');
    }
  }
}

/// Validate a single `MakoMarketsV4.createMarket(...)` call (sponsor-time,
/// kind='create_market'). Used by /api/aa/sponsor for the Phase 1H Magic
/// create-market flow. v4 redeploy (slice 4c) made this async to admit a
/// sponsor-time chain read of `blocked(safeAddress)` for non-MAKO creates
/// — without the read, a blocked Magic user can keep burning sponsor
/// budget on ops that revert on-chain.
///
/// `readBlocked` is passed in by the sponsor route so the validator stays
/// testable without RPC. Tests pass a stub (`async () => false` or
/// `async () => true` for the negative case). MAKO-type creates skip the
/// read entirely (bypass-by-design per codex r3 m-1: setBlocked could
/// flag the admin Safe but MAKO creation is gated by owner equality, not
/// blocklist).
export async function assertCreateMarketCall(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
  /// Latest Monad block timestamp. The sponsor route reads this once via
  /// getAaPublicClient(chainId).getBlock({ blockTag: 'latest' }) before
  /// invoking the validator. Browser Date.now() is NOT trusted.
  nowSec: bigint;
  /// Chain read of `MakoMarketsV4.blocked(safeAddress)`. Wired by the
  /// sponsor route to `publicClient.readContract({...})`. Tests stub.
  /// Called only for non-MAKO creates; MAKO bypasses by design.
  readBlocked: (safe: Address) => Promise<boolean>;
  /// Chain read of `MakoMarketsV4.creatorCreatesToday(safeAddress)`.
  /// Returns `(count, remaining)`. Non-MAKO only; MAKO is contract-exempt
  /// from the daily cap and skips this read. Mirrors the on-chain
  /// `CreatorDailyCapExceeded` revert so a doomed Magic create gets a
  /// 403 at sponsor time instead of burning sponsor budget round-tripping
  /// to a guaranteed-revert simulation.
  readCreatorCreatesToday: (
    safe: Address,
  ) => Promise<{ count: bigint; remaining: bigint }>;
}): Promise<void> {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  // Decode + structural checks + clock checks (sync). decodeCreateMarketArgs
  // is reused inside decodeAndAssertCreateMarket so the shape pass also
  // catches the new MAKO seed + mType-range + selector-first invariants.
  decodeAndAssertCreateMarket({ call: args.call, nowSec: args.nowSec });

  // MAKO admin gate (mirrors shape-side check for defense in depth — a
  // future refactor that bypasses the shape pre-flight still hits this).
  const decoded = decodeCreateMarketArgs(args.call);
  const mType = decoded[0];
  const MAKO_MARKET_TYPE = 6;
  if (mType === MAKO_MARKET_TYPE) {
    if (args.safeAddress.toLowerCase() !== MAKO_ADMIN_SAFE_ADDRESS) {
      throw new NotAllowedError('bad_create_mako_non_admin');
    }
    return; // MAKO bypasses blocklist + daily cap by design.
  }

  // Non-MAKO: sponsor-time chain read of blocked(safeAddress). A blocked
  // wallet's seed transfer would revert at the contract; reject here so
  // the user doesn't burn daily sponsor cap on a doomed op.
  const isBlocked = await args.readBlocked(args.safeAddress);
  if (isBlocked) {
    throw new NotAllowedError('bad_create_blocked_wallet');
  }

  // Non-MAKO: sponsor-time mirror of the contract's daily-cap invariant
  // (MakoMarketsV4 MAX_CREATES_PER_DAY = 10 per UTC day). Without this
  // read, a Magic user at the cap would burn sponsor budget bouncing off
  // `CreatorDailyCapExceeded` at simulation. The view returns the count
  // for the CURRENT UTC bucket — a reading taken seconds before midnight
  // can be stale by the time the op is mined, but at worst the user
  // succeeds on a fresh slot they would have gotten anyway; the contract
  // is still the authoritative gate. We key on `remaining === 0n` (codex
  // r1 NIT) rather than count >= 10n so a future contract bump to the
  // cap doesn't silently drift the mirror.
  const { remaining } = await args.readCreatorCreatesToday(args.safeAddress);
  if (remaining === 0n) {
    throw new NotAllowedError('bad_create_daily_cap_exceeded');
  }
}

/// Cheap shape-only validation — no clock, no chain RPC. Round-8 MINOR 1:
/// the sponsor route runs this BEFORE the `getBlock` call so a malicious
/// or misconfigured caller can't force the route to do an RPC roundtrip
/// for a request that would always reject on shape. Same shape checks
/// the full validator does (chainId, target, value, decode, mType,
/// question, immutable bettingCloseTime <= closeTime, MAKO admin gate,
/// creator-seed branch); skips the clock-relative checks AND the chain-
/// read blocklist gate (those live in the async sponsor validator).
/// Suitable for both pre-flight gating AND send-time re-validation.
export function assertCreateMarketShape(args: {
  chainId: number;
  safeAddress: Address;
  call: { to: Address; value: bigint; data: Hex };
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  decodeAndAssertCreateMarketShape({
    safeAddress: args.safeAddress,
    call: args.call,
  });
}

// ── Create-market batched validators (slice 4c-2) ───────────────────────────
//
// `create_market_batched` is the v4 redeploy analog of `bet_batched`. Magic
// users have zero USDC allowance on the new MakoMarketsV4 contract; a bare
// sponsored `createMarket` would `safeTransferFrom(creatorSeed)` and revert.
// Solution: bundle `[approve(USDC→MAKO, MaxUint256), createMarket(...)]`
// into a MultiSend op=1 via the same buildSponsoredUserOp path used for
// the bet flow.
//
// MAKO IS REJECTED FROM THIS PATH (codex r1 4e MAJOR 1). MAKO creates
// always carry `creatorSeed === 0n`, so no `safeTransferFrom` happens and
// the approve sub-call has nothing to do. Without this gate, an
// authenticated admin session could still POST a `create_market_batched`
// body with mType=MAKO and the sponsor would happily grant MAKO an
// unlimited USDC allowance via the batched dispatcher. We pre-screen
// mType from the createMarket sub-call AFTER the approve check (so
// reversed-order tuples still surface `bad_approval_target` from the
// approve decode) but BEFORE the inner single-call validator (which
// would otherwise let a 0-seed admin batched path through). No on-chain
// allowance has been granted at this point — the route's
// buildSponsoredUserOp call happens after this validator returns.
//
// Two variants per the plan r6 M-1 split:
//   - assertCreateMarketBatchedCallsSponsor  (async, awaits async single-call)
//   - assertCreateMarketBatchedCallsShape    (sync, no chain reads)

const MAKO_MARKET_TYPE_NUMBER = 6;

/// Pre-screen the createMarket sub-call's mType. Throws
/// `bad_create_mako_in_batched_path` if mType decodes to MAKO. Used by
/// both batched validators AFTER `decodeAndAssertApprove` (so a
/// reversed-order tuple still throws `bad_approval_target` first) and
/// BEFORE the recursive single-call validator (so a 0-seed admin
/// batched body is refused with a specific reason rather than slipping
/// through the inner MAKO-admin gate).
///
/// Does NOT use `decodeCreateMarketArgs` because that helper runs the
/// full single-call validation pipeline inline (including the MAKO-
/// nonzero-seed and seed-too-small branches), which would surface those
/// reasons first and mask the batched-path rejection. We only need the
/// first decoded arg (`mType`) — everything else is the inner
/// validator's job once the MAKO gate has passed.
function assertNotMakoInBatchedPath(call: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  // Pre-decode invariants — same reasons the single-call validator
  // would surface, kept in this gate so a malformed target / value /
  // selector doesn't accidentally pass the MAKO check by way of a
  // raw decode throw.
  if (call.to.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('bad_create_args', 'wrong_target');
  }
  if (call.value !== 0n) {
    throw new NotAllowedError('bad_value');
  }
  if (call.data.slice(0, 10).toLowerCase() !== CREATEMARKET_SELECTOR) {
    throw new NotAllowedError('bad_create_args', 'wrong_selector');
  }

  let mType: number;
  try {
    const result = decodeFunctionData({
      abi: CREATEMARKET_ABI,
      data: call.data,
    });
    if (result.functionName !== 'createMarket') {
      throw new NotAllowedError('bad_create_args', 'wrong_selector');
    }
    const args = result.args as unknown as readonly [number, ...unknown[]];
    mType = args[0];
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('bad_create_args', 'decode_failed');
  }

  if (mType === MAKO_MARKET_TYPE_NUMBER) {
    throw new NotAllowedError('bad_create_mako_in_batched_path');
  }
}

/// Sponsor-time async validator for the 2-call `[approve, createMarket]`
/// tuple. Awaits the recursive single-call sponsor validator so any
/// rejection from the inner createMarket path (including the chain-read
/// blocklist gate for non-MAKO) propagates as a NotAllowedError. The
/// MultiSend wrapper does NOT exist at this point — the route validates
/// the input tuple BEFORE buildSponsoredUserOp wraps it.
export async function assertCreateMarketBatchedCallsSponsor(args: {
  chainId: number;
  safeAddress: Address;
  calls: readonly [
    { to: Address; value: bigint; data: Hex },
    { to: Address; value: bigint; data: Hex },
  ];
  /// Latest Monad block timestamp — same shape as the single-call validator.
  nowSec: bigint;
  /// Chain read of `MakoMarketsV4.blocked(safeAddress)`. Threaded into the
  /// recursive single-call sponsor validator; MAKO inner branch bypasses.
  readBlocked: (safe: Address) => Promise<boolean>;
  /// Chain read of `MakoMarketsV4.creatorCreatesToday(safeAddress)`.
  /// Threaded into the recursive single-call validator. MAKO is rejected
  /// from the batched path entirely (assertNotMakoInBatchedPath), so this
  /// read always fires for inputs that get past the pre-screen.
  readCreatorCreatesToday: (
    safe: Address,
  ) => Promise<{ count: bigint; remaining: bigint }>;
}): Promise<void> {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  // Ordering: tuple[0] is the approve, tuple[1] is the createMarket.
  // A reversed-order tuple → bad_approval_target (tuple[0] target check
  // fires first since approve target=USDC and createMarket target=MAKO).
  decodeAndAssertApprove(args.calls[0]);
  // MAKO pre-screen (codex r1 4e MAJOR 1). Runs AFTER the approve
  // check (which catches structural problems like reversed tuples)
  // but BEFORE the inner single-call validator (which would
  // otherwise surface bad_create_mako_nonzero_seed /
  // bad_create_mako_non_admin and let a 0-seed admin path through).
  // The approve has already passed structurally at this point, but
  // no on-chain allowance has been granted yet — the route's
  // buildSponsoredUserOp call happens after this validator returns.
  assertNotMakoInBatchedPath(args.calls[1]);
  await assertCreateMarketCall({
    chainId: args.chainId,
    safeAddress: args.safeAddress,
    call: args.calls[1],
    nowSec: args.nowSec,
    readBlocked: args.readBlocked,
    readCreatorCreatesToday: args.readCreatorCreatesToday,
  });
}

/// Send-time sync shape-only batched validator. No clock, no chain RPC.
/// Recurses into `assertCreateMarketShape` for sub[1] so the MAKO admin
/// gate is re-checked at send-time alongside the immutable shape pass.
/// The route uses this as a pre-flight before getBlock + Pimlico round-
/// trip and again at send-time after Magic signing.
export function assertCreateMarketBatchedCallsShape(args: {
  chainId: number;
  safeAddress: Address;
  calls: readonly [
    { to: Address; value: bigint; data: Hex },
    { to: Address; value: bigint; data: Hex },
  ];
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('bad_create_args', 'wrong_chain');
  }
  decodeAndAssertApprove(args.calls[0]);
  // MAKO pre-screen mirror — see sponsor variant.
  assertNotMakoInBatchedPath(args.calls[1]);
  assertCreateMarketShape({
    chainId: args.chainId,
    safeAddress: args.safeAddress,
    call: args.calls[1],
  });
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

/// Validate Stage 1 invariants on the decoded PM CreateParams tuple.
/// No treasury, no clock, no RPC. Throws NotAllowedError on any
/// failure. Exported so the editMetadata validator can reuse it
/// without re-encoding the params back into createMarket-shaped
/// calldata (editMetadata's selector is distinct; the createMarket
/// stage entry points require the wrapping selector to match).
export function assertPmCreateParamsShapeNoTreasury(
  p: PmCreateParamsTuple,
): void {
  _assertPmCreateMarketSemanticsNoTreasury(p);
}

/// Validate Stage 2 treasury exclusion on the decoded PM CreateParams
/// tuple. Pure sync. Exported so editMetadata can reuse the same
/// treasury check that runs on createMarket. Treasury comparison is
/// case-insensitive; the caller must have already resolved the
/// treasury address (typically via the cached
/// `getPmTreasuryAddress()` accessor).
export function assertPmCreateParamsTreasuryExclusion(
  p: PmCreateParamsTuple,
  treasury: Address,
): void {
  _assertPmCreateMarketTreasuryExclusion(p, treasury);
}

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
  if (!isPmTarget(call.to)) {
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
///
/// Async since Phase 2C-1 step 10: the PM dispatch path needs to
/// await getPmTreasuryAddress() (chain read, cached after first call)
/// to run Stage 2's treasury-exclusion check. The PM dispatcher itself
/// is the only async work — all other branches resolve synchronously,
/// just wrapped in a Promise.
export async function assertSponsoredCallData(args: {
  chainId: number;
  safeAddress: Address;
  callData: Hex;
}): Promise<void> {
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
      // and createMarket (0xd1aa0ea8 after the v4 redeploy that appended
      // creatorSeed + creatorYes; the prior 5-arg signature was
      // 0xda6a7338) are the two MAKO methods we
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
        // bundler is reached. Pass safeAddress so the MAKO admin gate
        // re-checks at send-time (defense-in-depth against drift between
        // the sponsor-time approval and the persisted callData).
        decodeAndAssertCreateMarketShape({
          safeAddress: args.safeAddress,
          call: { to, value, data },
        });
        return;
      }
      if (innerSelector === CLAIM_SELECTOR) {
        // claim-magic-parity: shape-only at send-time. No clock-
        // relative checks (claim has none); contract enforces
        // resolution + position + has-not-claimed.
        decodeAndAssertClaimShape({ to, value, data });
        return;
      }
      throw new NotAllowedError('bad_selector');
    }
    if (isPmTarget(to)) {
      // Phase 2C-1 + 2E-1 PM send-time dispatch. Mirrors the MAKO branch's
      // chainId guard + per-selector dispatch. 11 PM selectors total:
      //   - createMarket  (2C-1)
      //   - bet, stake, claim, resolve, confirm, distribute, cancel,
      //     finalize, finalizeMetadata, editMetadata  (2E-1)
      //
      // Send-time runs SHAPE-ONLY validators — no chain hydration, no
      // clock-relative checks, no state checks. Drift in time / state
      // is caught by Guard A (SafeOp hash recomputation) before the
      // bundler is reached. The structural shape checks here are an
      // independent layer against forged inner calls.
      if (args.chainId !== MONAD_TESTNET_ID) {
        throw new NotAllowedError('pm_bad_create_args', 'wrong_chain');
      }
      if (data.length < 10) {
        throw new NotAllowedError('bad_selector');
      }
      const innerSelector = data.slice(0, 10).toLowerCase();
      const innerCall = { to, value, data };

      if (innerSelector === PM_CREATE_MARKET_SELECTOR) {
        const treasury = await getPmTreasuryAddress();
        assertPmCreateMarketShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
          treasury,
        });
        return;
      }
      if (innerSelector === PM_EDIT_METADATA_SELECTOR) {
        const treasury = await getPmTreasuryAddress();
        assertPmEditMetadataCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
          treasury,
        });
        return;
      }
      if (innerSelector === PM_BET_SELECTOR) {
        assertPmBetCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_STAKE_SELECTOR) {
        assertPmStakeCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === _PM_CLAIM_SELECTOR_FOR_DISPATCH) {
        // PM claim selector collides with v4 claim (same signature);
        // we already discriminated on wrapper.to === PM_CONTRACT_ADDRESS
        // above, so this is unambiguous.
        assertPmClaimCall({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_RESOLVE_SELECTOR) {
        assertPmResolveCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_CONFIRM_SELECTOR) {
        assertPmConfirmCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_DISTRIBUTE_SELECTOR) {
        assertPmDistributeCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_CANCEL_SELECTOR) {
        assertPmCancelCallShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_FINALIZE_SELECTOR) {
        assertPmFinalizeCall({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      if (innerSelector === PM_FINALIZE_METADATA_SELECTOR) {
        assertPmFinalizeMetadataCall({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          call: innerCall,
        });
        return;
      }
      throw new NotAllowedError('bad_selector');
    }
    if (isRoundsTarget(to)) {
      // Rounds (MakoRoundsV1): the same decoders as sponsor time, by selector. Never true while Rounds is not
      // live, and Rounds' claim shares the Pools claim selector, so the target decides first.
      if (args.chainId !== MONAD_TESTNET_ID) {
        throw new NotAllowedError('round_bad_target');
      }
      assertRoundsSendCall({ to, value, data });
      // The chain must still show the reviewed Rounds code at that address (Codex S2 r1).
      await assertRoundsRelease();
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

    // Codex r1 MAJ-1: dispatch by sub[1].to. The MultiSend wrapper
    // shape is [approve(USDC → spender, amount), action(...)]: MaxUint256 for Pools, exactly the entry for Rounds.
    // The action target tells us which validator to run:
    //   - MAKO_ADDRESS → v4 batched bet (existing 1D flow)
    //   - PM_CONTRACT_ADDRESS → PM batched bet OR stake (selector
    //     discriminates inside the PM batched shape validator)
    //
    // The approve sub-call gets validated INSIDE the chosen branch
    // (each branch knows the spender it expects). Keeping the
    // dispatch on sub[1].to mirrors the op=0 branch's dispatch-by-
    // target pattern.
    const sub0 = { to: sub[0].to, value: sub[0].value, data: sub[0].data };
    const sub1 = { to: sub[1].to, value: sub[1].value, data: sub[1].data };

    if (sub1.to.toLowerCase() === MAKO_ADDRESS.toLowerCase()) {
      // v4 MAKO target carries TWO batched actions today: placeBet
      // (existing 1D flow) and createMarket (slice 4c-2). Discriminate
      // by inner selector so a typo'd selector can't silently route to
      // the wrong validator.
      if (sub1.data.length < 10) {
        throw new NotAllowedError('bad_selector');
      }
      const makoInnerSelector = sub1.data.slice(0, 10).toLowerCase();
      if (makoInnerSelector === PLACEBET_SELECTOR) {
        decodeAndAssertApprove(sub0);
        decodeAndAssertPlaceBet(sub1);
        return;
      }
      if (makoInnerSelector === CREATEMARKET_SELECTOR) {
        // Send-time uses the shape variant — clock + chain-read are caught
        // by Guard A (SafeOp hash recomputation) before the bundler is
        // reached. MAKO admin gate IS re-checked here via the recursive
        // assertCreateMarketShape inside the batched shape validator.
        assertCreateMarketBatchedCallsShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          calls: [sub0, sub1] as const,
        });
        return;
      }
      throw new NotAllowedError('bad_selector');
    }
    if (isPmTarget(sub1.to)) {
      // PM batched: discriminate bet vs stake by inner selector. The
      // approve sub-call is validated inside the batched shape
      // validator (spender must be PM_CONTRACT_ADDRESS).
      if (sub1.data.length < 10) {
        throw new NotAllowedError('bad_selector');
      }
      const sub1Selector = sub1.data.slice(0, 10).toLowerCase();
      if (sub1Selector === PM_BET_SELECTOR) {
        assertPmBetBatchedCallsShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          calls: [sub0, sub1] as const,
        });
        return;
      }
      if (sub1Selector === PM_STAKE_SELECTOR) {
        assertPmStakeBatchedCallsShape({
          chainId: args.chainId,
          safeAddress: args.safeAddress,
          calls: [sub0, sub1] as const,
        });
        return;
      }
      throw new NotAllowedError('bad_selector');
    }
    if (isRoundsTarget(sub1.to)) {
      // Rounds: only [approve(ROUNDS, <the enter amount>) on USDC, enter(...)] (Codex S2 r1).
      assertRoundsSendBatched(sub0, sub1);
      await assertRoundsRelease();
      return;
    }
    // Unknown sub[1] target. Reject defensively — neither v4 batched
    // bet nor PM batched bet/stake.
    throw new NotAllowedError('bad_multisend_target');
  }

  // Any other operation value — Safe defines op=0 (CALL) and op=1
  // (DELEGATECALL); op=2 (CREATE) is not part of the userOp wrapper
  // surface. Reject defensively.
  throw new NotAllowedError('bad_operation');
}
