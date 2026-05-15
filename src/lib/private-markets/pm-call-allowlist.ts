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

import {
  PM_CLAIM_ABI,
  PM_CLAIM_SELECTOR,
  PM_FINALIZE_ABI,
  PM_FINALIZE_SELECTOR,
  PM_FINALIZE_METADATA_ABI,
  PM_FINALIZE_METADATA_SELECTOR,
} from './abi-fragments';

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
