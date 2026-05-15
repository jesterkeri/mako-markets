import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/pm-call-allowlist.ts
//
// Phase 2E-1: per-action allowlist validators for MakoPrivateMarketsV1.
// Companion to `src/lib/aa-call-allowlist.ts`'s createMarket validator;
// the 10 action selectors live here so the createMarket module stays
// focused and the new action surface stays adjacent to its own ABI
// fragments (`abi-fragments.ts`) and chain-state helper
// (`sponsor-chain-state.ts`).
//
// Slice 1C-1 covers the THREE lightweight "anyone-can-call" idempotent
// actions:
//
//   - claim(uint256)              — staker payout
//   - finalize(uint256)           — lazy state finalization
//   - finalizeMetadata(uint256)   — post-open metadata-frozen advisory
//
// All three share the same shape: a single uint256 marketId argument,
// target=PM_CONTRACT_ADDRESS, value=0n, selector pinned by the
// abi-fragments module. The contract itself enforces all stateful
// gates (market existence, state, time, idempotency) so the validator's
// job is purely structural — reject anything that isn't a well-formed
// call against the PM contract.
//
// No chain state, no clock, no RPC. The route's pre-flight gate runs
// these in O(microseconds) before any RPC roundtrip.
//
// Slice 1C-2 / 1C-3 / 1C-4 will add bet + stake + creator actions +
// editMetadata, which DO require chain state via
// `readSponsorMarketState`.
//
// Each validator's `assertPmXCall` signature mirrors the v4 surface
// (`assertCreateMarketCall`, `assertClaimCall`, etc.): `chainId`,
// `safeAddress`, and a `call` tuple. `safeAddress` is unused at this
// slice's level — every send-time sender check is enforced by the
// contract via `msg.sender == m.creator` / `_stakeCommon`'s allowlist
// check — but kept in the signature for parity with the rest of the
// validator surface and for future expansion.
// ----------------------------------------------------------------------------

import { decodeFunctionData, type Address, type Hex } from 'viem';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { NotAllowedError } from '@/lib/aa-call-allowlist';
import { PM_MIN_STAKE_USDC_BASE_UNITS } from '@/lib/aa-constants';
import type { SupportedAaChainId } from '@/lib/aa-config';

import {
  PM_BET_ABI,
  PM_BET_SELECTOR,
  PM_CLAIM_ABI,
  PM_CLAIM_SELECTOR,
  PM_FINALIZE_ABI,
  PM_FINALIZE_SELECTOR,
  PM_FINALIZE_METADATA_ABI,
  PM_FINALIZE_METADATA_SELECTOR,
  PM_STAKE_ABI,
  PM_STAKE_SELECTOR,
} from './abi-fragments';
import { normalizeAddressLower } from './normalize';
import { getPmTreasuryAddress } from './treasury';
import {
  PmMarketState,
  readSponsorMarketState,
  type SponsorMarketState,
  type SponsorMarketStateCache,
  type SponsorMarketStateResult,
} from './sponsor-chain-state';

// ── Shared decode helpers ───────────────────────────────────────────────────

interface CallTuple {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

/// Centralized target + value + chainId + selector gating shared by
/// every action's outer decode. The `expectedSelector` is compared
/// case-insensitively because viem returns lowercase but the SDK's
/// callData may surface as mixed case in older code paths.
function assertOuterShape(args: {
  chainId: number;
  call: CallTuple;
  expectedSelector: Hex;
  reasonOnFailure:
    | 'pm_bad_claim_args'
    | 'pm_bad_finalize_args'
    | 'pm_bad_finalize_metadata_args';
}): void {
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError(args.reasonOnFailure, 'wrong_chain');
  }
  if (args.call.to.toLowerCase() !== PM_CONTRACT_ADDRESS.toLowerCase()) {
    throw new NotAllowedError(args.reasonOnFailure, 'wrong_target');
  }
  if (args.call.value !== 0n) {
    throw new NotAllowedError(args.reasonOnFailure, 'bad_value');
  }
  if (args.call.data.length < 10) {
    throw new NotAllowedError(args.reasonOnFailure, 'short_calldata');
  }
  if (args.call.data.slice(0, 10).toLowerCase() !== args.expectedSelector) {
    throw new NotAllowedError(args.reasonOnFailure, 'wrong_selector');
  }
}

/// Single-uint256 ABI decode. PM claim / finalize / finalizeMetadata all
/// take exactly one `marketId` argument; this helper centralizes the
/// decode + non-negative assertion. viem already constrains uint256 to
/// non-negative, but the explicit check survives if the decoder ever
/// loosens.
function decodeMarketIdArg(
  abi:
    | typeof PM_CLAIM_ABI
    | typeof PM_FINALIZE_ABI
    | typeof PM_FINALIZE_METADATA_ABI,
  data: Hex,
  reasonOnFailure:
    | 'pm_bad_claim_args'
    | 'pm_bad_finalize_args'
    | 'pm_bad_finalize_metadata_args',
): bigint {
  let decoded: {
    functionName: 'claim' | 'finalize' | 'finalizeMetadata';
    args: readonly [bigint];
  };
  try {
    const result = decodeFunctionData({ abi, data });
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError(reasonOnFailure, 'decode_failed');
  }
  const [marketId] = decoded.args;
  if (typeof marketId !== 'bigint') {
    throw new NotAllowedError(reasonOnFailure, 'bad_market_id_type');
  }
  if (marketId < 0n) {
    throw new NotAllowedError(reasonOnFailure, 'bad_market_id');
  }
  return marketId;
}

// ── Validators ──────────────────────────────────────────────────────────────

/// Validate a single PM `claim(uint256)` call. Anyone-can-call action;
/// the contract enforces resolution state, position, and has-not-claimed
/// on chain. The allowlist's job is structural: reject anything that
/// isn't a well-formed claim against the PM contract.
///
/// Distinct from v4's `assertClaimCall` (same signature, same 4-byte
/// selector). The send-time dispatcher in aa-call-allowlist.ts'
/// `assertSponsoredCallData` discriminates by `wrapper.to` —
/// PM_CONTRACT_ADDRESS routes here; MAKO_ADDRESS routes to v4.
export function assertPmClaimCall(args: {
  chainId: number;
  safeAddress: Address;
  call: CallTuple;
}): void {
  assertOuterShape({
    chainId: args.chainId,
    call: args.call,
    expectedSelector: PM_CLAIM_SELECTOR,
    reasonOnFailure: 'pm_bad_claim_args',
  });
  decodeMarketIdArg(PM_CLAIM_ABI, args.call.data, 'pm_bad_claim_args');
}

/// Validate a single PM `finalize(uint256)` call. Anyone-can-call lazy
/// finalization (Created → ZeroStakeExpired or Created → TimedOut). The
/// contract handles idempotency (`m.state != Created` returns early
/// without revert) and "not yet finalizable" (`NothingToFinalize`
/// revert).
export function assertPmFinalizeCall(args: {
  chainId: number;
  safeAddress: Address;
  call: CallTuple;
}): void {
  assertOuterShape({
    chainId: args.chainId,
    call: args.call,
    expectedSelector: PM_FINALIZE_SELECTOR,
    reasonOnFailure: 'pm_bad_finalize_args',
  });
  decodeMarketIdArg(PM_FINALIZE_ABI, args.call.data, 'pm_bad_finalize_args');
}

/// Validate a single PM `finalizeMetadata(uint256)` call. Anyone-can-call
/// metadata-frozen advisory. The contract guards with
/// `MetadataFreezeNotReady` until `block.timestamp >= stakingOpensAt`
/// and is idempotent after `metadataFrozenEmitted` flips.
export function assertPmFinalizeMetadataCall(args: {
  chainId: number;
  safeAddress: Address;
  call: CallTuple;
}): void {
  assertOuterShape({
    chainId: args.chainId,
    call: args.call,
    expectedSelector: PM_FINALIZE_METADATA_SELECTOR,
    reasonOnFailure: 'pm_bad_finalize_metadata_args',
  });
  decodeMarketIdArg(
    PM_FINALIZE_METADATA_ABI,
    args.call.data,
    'pm_bad_finalize_metadata_args',
  );
}

// ── bet + stake validators (slice 1C-2) ─────────────────────────────────────
//
// Bet (Friendly) and stake (OpenVote / PrizePool) both run through the
// contract's `_stakeCommon` gate which enforces: treasury exclusion,
// state == Created, time ∈ [stakingOpensAt, closeAt), allowlist
// membership, and per-stake bounds. The two validators share Stages
// C-G (chain-state hydration + treasury / state / time / allowlist /
// bounds checks); only Stages A-B (shape decode + per-shape argument
// constraints) differ.
//
// Stages (plan v8 carry-forward from v7's A-G):
//   A. outer shape (chainId / target / value / calldata / selector)
//   B. ABI decode + per-call argument bounds (side or optionIndex,
//      amount > 0n)
//   C. chain-state hydration via readSponsorMarketState; failure
//      reasons map directly to NotAllowedReason
//   D. treasury exclusion (sender !== treasury); via the cached
//      getPmTreasuryAddress accessor + normalizeAddressLower MAJ-1
//   E. shape gate (Friendly vs Vote; option index in range for stake)
//   F. state gate (storedState === Created); covers Resolved /
//      Canceled / EmptyPoolResolved / TimedOut / ZeroStakeExpired
//   G. time gate + allowlist + per-stake bounds (per-shape bounds
//      logic differs but is otherwise mechanical)
//
// Notes:
//   - PrizePool cumulative cap is NOT enforced here. It requires reading
//     the staker's previous cumulative stake which is per-user state;
//     the contract's `WalletCapExceeded` revert is the source of truth.
//     The validator pre-flight is intentionally optimistic on cumulative
//     — better to spend a sponsor budget unit than to maintain a third
//     per-user index in the request hot path.
//   - OpenVote: contract enforces `amount == fixedStake` AND single-vote
//     per wallet (`AlreadyVoted`). The validator enforces the first but
//     not the second (one-vote is per-user state). Same trade-off.
//   - bigint comparisons everywhere — never coerce to Number.

const FRIENDLY_NO = 0;
const FRIENDLY_YES = 1;

/// Map a SponsorMarketStateResult failure to the appropriate
/// NotAllowedError. Shared by every validator that hydrates chain
/// state. Three reasons:
///   - market_not_found            → pm_market_not_found
///   - pm_state_rpc_failure        → pm_state_rpc_failure
///   - pm_bad_state_shape_unknown  → pm_bad_state_shape_unknown
function throwFromHydrationFailure(
  result: Exclude<SponsorMarketStateResult, { ok: true }>,
): never {
  if (result.reason === 'market_not_found') {
    throw new NotAllowedError('pm_market_not_found');
  }
  if (result.reason === 'pm_state_rpc_failure') {
    throw new NotAllowedError('pm_state_rpc_failure');
  }
  // exhaustive: only `pm_bad_state_shape_unknown` remains
  throw new NotAllowedError('pm_bad_state_shape_unknown');
}

/// Hydrate market state and unwrap. Throws via `throwFromHydrationFailure`
/// on any non-ok result.
async function hydrateMarketStateOrThrow(args: {
  chainId: SupportedAaChainId;
  marketId: bigint;
  cache: SponsorMarketStateCache;
}): Promise<SponsorMarketState> {
  const result = await readSponsorMarketState(args);
  if (!result.ok) throwFromHydrationFailure(result);
  return result.state;
}

/// Stage D-G: shared gates for bet + stake. The contract's `_stakeCommon`
/// is the source of truth — every check here mirrors a single contract
/// gate. Failure routes to the most specific NotAllowedReason so a
/// 403 carries actionable detail (operator can tell "user not on
/// allowlist" from "market already resolved").
async function assertStakeCommonGates(args: {
  state: SponsorMarketState;
  safeAddressLower: `0x${string}`;
  amount: bigint;
  nowSec: bigint;
  applyPerStakeBounds: boolean;
  reasonNamespace: 'pm_bad_bet_args' | 'pm_bad_stake_args';
}): Promise<void> {
  // Stage D — treasury exclusion (plan v8 MAJ-1: both sides normalized).
  const treasury = normalizeAddressLower(await getPmTreasuryAddress());
  if (args.safeAddressLower === treasury) {
    throw new NotAllowedError('pm_bad_stake_treasury');
  }

  // Stage F — stored state must be Created. Contract gate:
  //   if (m.state != MarketState.Created) revert StakingClosed();
  if (args.state.storedState !== PmMarketState.Created) {
    throw new NotAllowedError('pm_bad_stake_state', 'not_created');
  }

  // Stage G part 1 — time window. Contract gates:
  //   if (block.timestamp < m.stakingOpensAt) revert StakingNotOpen();
  //   if (block.timestamp >= m.closeAt) revert StakingClosed();
  if (args.nowSec < args.state.stakingOpensAt) {
    throw new NotAllowedError('pm_bad_stake_time', 'not_open');
  }
  if (args.nowSec >= args.state.closeAt) {
    throw new NotAllowedError('pm_bad_stake_time', 'closed');
  }

  // Stage G part 2 — allowlist. The presence of a non-empty allowlist
  // implies `participationMode == Allowlisted` (createMarket enforces
  // this invariant). Inferring from `length > 0` keeps the chain-state
  // helper minimal while remaining functionally equivalent — see
  // sponsor-chain-state.ts file header.
  if (args.state.allowlist.length > 0) {
    if (!args.state.allowlist.includes(args.safeAddressLower)) {
      throw new NotAllowedError('pm_bad_stake_allowlist');
    }
  }

  // Stage G part 3 — per-stake bounds (skipped for OpenVote since the
  // contract enforces `amount == fixedStake` upstream). The contract's
  // floor:
  //   floor = m.perStakeMin == 0 ? MIN_STAKE : m.perStakeMin;
  // The validator mirrors this exactly.
  if (args.applyPerStakeBounds) {
    const floor =
      args.state.perStakeMin === 0n
        ? PM_MIN_STAKE_USDC_BASE_UNITS
        : args.state.perStakeMin;
    if (args.amount < floor) {
      throw new NotAllowedError('pm_bad_stake_bounds', 'below_floor');
    }
    if (args.state.perStakeMax !== 0n && args.amount > args.state.perStakeMax) {
      throw new NotAllowedError('pm_bad_stake_bounds', 'above_cap');
    }
  }

  // Caller's `reasonNamespace` is unused inside the helper because the
  // contract gates have their own dedicated reason codes
  // (pm_bad_stake_treasury, pm_bad_stake_state, ...). The parameter is
  // retained on the signature for explicit dispatch when the per-action
  // semantics diverge in a future slice.
  void args.reasonNamespace;
}

/// Validate a single PM `bet(marketId, side, amount)` call. Friendly-only
/// binary YES/NO bet. Async: hydrates chain state via the request-scoped
/// cache. `nowSec` MUST be a Monad block timestamp (sponsor route reads
/// once via `getAaPublicClient(...).getBlock({ blockTag: 'latest' })`).
export async function assertPmBetCall(args: {
  chainId: SupportedAaChainId;
  safeAddress: Address;
  call: CallTuple;
  nowSec: bigint;
  cache: SponsorMarketStateCache;
}): Promise<void> {
  // ── Stage A — outer shape ────────────────────────────────────────────────
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('pm_bad_bet_args', 'wrong_chain');
  }
  if (args.call.to.toLowerCase() !== PM_CONTRACT_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('pm_bad_bet_args', 'wrong_target');
  }
  if (args.call.value !== 0n) {
    throw new NotAllowedError('pm_bad_bet_args', 'bad_value');
  }
  if (args.call.data.length < 10) {
    throw new NotAllowedError('pm_bad_bet_args', 'short_calldata');
  }
  if (args.call.data.slice(0, 10).toLowerCase() !== PM_BET_SELECTOR) {
    throw new NotAllowedError('pm_bad_bet_args', 'wrong_selector');
  }

  // ── Stage B — ABI decode + arg constraints ───────────────────────────────
  let decoded: {
    functionName: 'bet';
    args: readonly [bigint, number, bigint];
  };
  try {
    const result = decodeFunctionData({
      abi: PM_BET_ABI,
      data: args.call.data,
    });
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('pm_bad_bet_args', 'decode_failed');
  }
  const [marketId, side, amount] = decoded.args;
  if (side !== FRIENDLY_NO && side !== FRIENDLY_YES) {
    throw new NotAllowedError('pm_bad_bet_args', 'bad_side');
  }
  if (amount <= 0n) {
    throw new NotAllowedError('pm_bad_bet_args', 'bad_amount');
  }

  // ── Stage C — hydrate market state ───────────────────────────────────────
  const state = await hydrateMarketStateOrThrow({
    chainId: args.chainId,
    marketId,
    cache: args.cache,
  });

  // ── Stage E — shape gate (Friendly only) ─────────────────────────────────
  if (state.shape !== 0) {
    throw new NotAllowedError('pm_bad_bet_args', 'wrong_shape');
  }

  // ── Stages D / F / G — common stake gates ────────────────────────────────
  await assertStakeCommonGates({
    state,
    safeAddressLower: normalizeAddressLower(args.safeAddress),
    amount,
    nowSec: args.nowSec,
    applyPerStakeBounds: true,
    reasonNamespace: 'pm_bad_bet_args',
  });
}

/// Validate a single PM `stake(marketId, optionIndex, amount)` call.
/// OpenVote / PrizePool only; Friendly must use `bet`. Async: hydrates
/// chain state via the request-scoped cache.
export async function assertPmStakeCall(args: {
  chainId: SupportedAaChainId;
  safeAddress: Address;
  call: CallTuple;
  nowSec: bigint;
  cache: SponsorMarketStateCache;
}): Promise<void> {
  // ── Stage A — outer shape ────────────────────────────────────────────────
  if (args.chainId !== MONAD_TESTNET_ID) {
    throw new NotAllowedError('pm_bad_stake_args', 'wrong_chain');
  }
  if (args.call.to.toLowerCase() !== PM_CONTRACT_ADDRESS.toLowerCase()) {
    throw new NotAllowedError('pm_bad_stake_args', 'wrong_target');
  }
  if (args.call.value !== 0n) {
    throw new NotAllowedError('pm_bad_stake_args', 'bad_value');
  }
  if (args.call.data.length < 10) {
    throw new NotAllowedError('pm_bad_stake_args', 'short_calldata');
  }
  if (args.call.data.slice(0, 10).toLowerCase() !== PM_STAKE_SELECTOR) {
    throw new NotAllowedError('pm_bad_stake_args', 'wrong_selector');
  }

  // ── Stage B — ABI decode + arg constraints ───────────────────────────────
  let decoded: {
    functionName: 'stake';
    args: readonly [bigint, bigint, bigint];
  };
  try {
    const result = decodeFunctionData({
      abi: PM_STAKE_ABI,
      data: args.call.data,
    });
    decoded = result as unknown as typeof decoded;
  } catch (e) {
    if (e instanceof NotAllowedError) throw e;
    throw new NotAllowedError('pm_bad_stake_args', 'decode_failed');
  }
  const [marketId, optionIndex, amount] = decoded.args;
  if (amount <= 0n) {
    throw new NotAllowedError('pm_bad_stake_args', 'bad_amount');
  }

  // ── Stage C — hydrate market state ───────────────────────────────────────
  const state = await hydrateMarketStateOrThrow({
    chainId: args.chainId,
    marketId,
    cache: args.cache,
  });

  // ── Stage E — shape gate ─────────────────────────────────────────────────
  // Friendly markets must use bet(); stake on Friendly reverts WrongShape.
  if (state.shape === 0) {
    throw new NotAllowedError('pm_bad_stake_args', 'wrong_shape');
  }
  // option bounds:
  //   if (optionIndex >= _optionLabels[marketId].length) revert InvalidOutcome();
  if (optionIndex >= BigInt(state.options.length)) {
    throw new NotAllowedError('pm_bad_stake_args', 'option_out_of_range');
  }

  // ── OpenVote-specific check: amount == fixedStake ────────────────────────
  // Contract gate (OpenVote branch):
  //   if (amount != m.fixedStake) revert AmountAboveCap();
  // OpenVote also bypasses per-stake min/max — the contract skips those
  // checks for `shape != Friendly && shape != PrizePool`. Validator
  // mirrors that by passing applyPerStakeBounds=false for OpenVote.
  const isOpenVote = state.shape === 1;
  if (isOpenVote && amount !== state.fixedStake) {
    throw new NotAllowedError('pm_bad_stake_args', 'open_vote_amount_mismatch');
  }

  // ── Stages D / F / G — common stake gates ────────────────────────────────
  await assertStakeCommonGates({
    state,
    safeAddressLower: normalizeAddressLower(args.safeAddress),
    amount,
    nowSec: args.nowSec,
    // PrizePool runs per-stake bounds; OpenVote skips them (contract
    // enforces equality against fixedStake instead).
    applyPerStakeBounds: !isOpenVote,
    reasonNamespace: 'pm_bad_stake_args',
  });
}
