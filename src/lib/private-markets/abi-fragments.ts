// ----------------------------------------------------------------------------
// src/lib/private-markets/abi-fragments.ts
//
// PM action ABI fragments + 4-byte selectors for the MakoPrivateMarketsV1
// contract. Source of truth for both encode-side (aa-client.ts orchestrators)
// and decode-side (pm-call-allowlist validators) of the userOp pipeline.
//
// Phase 2C-1: createMarket fragment + selector (the only state-changing
// action that needs a draft row, because the marketId doesn't exist
// pre-tx).
//
// Phase 2E-1: 10 additional action fragments — bet, stake, claim, resolve,
// confirm, distribute, cancel, finalize, finalizeMetadata, editMetadata.
// None need a draft row; the marketId is the natural identity.
//
// Field order in CreateParams MUST match the Solidity struct exactly
// (MakoPrivateMarketsV1.sol lines 189-207). The compiler emits args by
// struct order, not by name, so a re-ordered fragment produces a different
// selector. The pm-allowlist selector pin tests guard against drift by
// comparing each *_SELECTOR constant against a hardcoded hex literal —
// computing both sides via toFunctionSelector would silently agree even
// when the ABI fragment drifts from the contract source.
//
// PmCreateParamsTuple is the object-form callers use (browser + server
// share this). viem's encodeFunctionData/decodeFunctionData accept the
// named-field form for `tuple` ABI types.
// ----------------------------------------------------------------------------

import type { Address, Hex } from 'viem';
import { toFunctionSelector } from 'viem';

export const PM_CREATE_MARKET_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'shape', type: 'uint8' }, // 0
          { name: 'stakingOpensAt', type: 'uint64' }, // 1
          { name: 'closeAt', type: 'uint64' }, // 2
          { name: 'title', type: 'bytes' }, // 3
          { name: 'description', type: 'bytes' }, // 4
          { name: 'streamUrl', type: 'bytes' }, // 5
          { name: 'optionLabels', type: 'bytes[]' }, // 6
          { name: 'participantWallets', type: 'address[]' }, // 7
          { name: 'allowlist', type: 'address[]' }, // 8
          { name: 'viewMode', type: 'uint8' }, // 9
          { name: 'participationMode', type: 'uint8' }, // 10
          { name: 'perStakeMin', type: 'uint256' }, // 11
          { name: 'perStakeMax', type: 'uint256' }, // 12
          { name: 'perWalletCumulativeMax', type: 'uint256' }, // 13
          { name: 'fixedStake', type: 'uint256' }, // 14
          { name: 'winnersCount', type: 'uint8' }, // 15
          { name: 'clientNonce', type: 'bytes32' }, // 16
        ],
      },
    ],
    outputs: [{ name: 'marketId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

/// Pinned 4-byte selector. Computed once at module load via
/// `toFunctionSelector`. The aa-call-allowlist-selectors.test.ts test
/// compares this runtime value against a HARDCODED hex literal —
/// computing both sides via toFunctionSelector would silently agree
/// even when the ABI fragment drifts from the contract source.
export const PM_CREATE_MARKET_SELECTOR: Hex = toFunctionSelector(
  PM_CREATE_MARKET_ABI[0],
);

/// PM treasury view function — immutable, set in constructor. Used by
/// /create/private to feed validatePmCreateForm so treasury-in-allowlist
/// + treasury-in-participants are blocked at submit time (Codex r2 MAJ-2).
/// Server-side reads use src/lib/private-markets/treasury.ts (memoized);
/// the client uses this ABI fragment via wagmi's useReadContract for a
/// single chain-direct lookup on /create/private mount.
export const PM_TREASURY_ABI = [
  {
    type: 'function',
    name: 'treasury',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
] as const;

/// Browser-and-server-shared shape of CreateParams. Object form (not
/// positional tuple) because viem's encodeFunctionData accepts either
/// and the named form is far less footgun-prone for callers. Field
/// types mirror the contract's CreateParams struct verbatim.
export interface PmCreateParamsTuple {
  shape: 0 | 1 | 2; // Friendly / OpenVote / PrizePool
  stakingOpensAt: bigint; // uint64 seconds-since-epoch
  closeAt: bigint; // uint64
  title: Hex; // bytes (utf-8)
  description: Hex; // bytes (utf-8; "" allowed)
  streamUrl: Hex; // bytes (ascii URL; "" allowed)
  optionLabels: readonly Hex[]; // bytes[] (len 2..MAX_OPTIONS)
  participantWallets: readonly Address[]; // address[] (PrizePool only)
  allowlist: readonly Address[]; // address[] (Allowlisted only)
  viewMode: 0 | 1; // LinkOnly / Public (contract enum order)
  participationMode: 0 | 1; // Open / Allowlisted
  perStakeMin: bigint; // uint256 (0 = defaults to MIN_STAKE)
  perStakeMax: bigint; // uint256 (0 = no cap)
  perWalletCumulativeMax: bigint; // uint256 (0 = no cap, PrizePool only)
  fixedStake: bigint; // uint256 (OpenVote only)
  winnersCount: number; // uint8 (Vote shapes only)
  clientNonce: Hex; // bytes32
}

// ===========================================================================
// Phase 2E-1 action fragments
// ===========================================================================
//
// Ten state-changing actions on MakoPrivateMarketsV1. Each fragment is the
// source of truth for both encode-side (aa-client orchestrators) and
// decode-side (pm-call-allowlist validators). Selectors are pinned hex
// literals; the pin tests compare runtime `toFunctionSelector(fragment)`
// against the literal — drift in EITHER side trips the test.
//
// Shape dispatch:
//   - Friendly:   bet(marketId, side, amount)        — side ∈ {0=NO, 1=YES}
//   - OpenVote:   stake(marketId, optionIndex, fixedStake)  — one vote per wallet TOTAL
//   - PrizePool:  stake(marketId, optionIndex, amount)       — multi-stake per wallet
//
// Creator-action (gated by _requireCreatorAction on chain):
//   - Friendly:   resolve(marketId, outcome)  — outcome ∈ {0, 1}; NO REFUND
//   - OpenVote:   confirm(marketId)
//   - PrizePool:  distribute(marketId)
//   - Any shape:  cancel(marketId)
//
// Anyone-can-call (idempotent):
//   - finalize(marketId)            — post-close lazy state finalization
//   - finalizeMetadata(marketId)    — post-open metadata-frozen advisory
//   - claim(marketId)               — per-wallet payout (any staker)
//
// Creator metadata edit (pre-stakingOpensAt only):
//   - editMetadata(marketId, p)     — replays _validateCreate; shape immutable

export const PM_BET_ABI = [
  {
    type: 'function',
    name: 'bet',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_STAKE_ABI = [
  {
    type: 'function',
    name: 'stake',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'optionIndex', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_CLAIM_ABI = [
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_CANCEL_ABI = [
  {
    type: 'function',
    name: 'cancel',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_RESOLVE_ABI = [
  {
    type: 'function',
    name: 'resolve',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      { name: 'outcome', type: 'uint8' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_CONFIRM_ABI = [
  {
    type: 'function',
    name: 'confirm',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_DISTRIBUTE_ABI = [
  {
    type: 'function',
    name: 'distribute',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_FINALIZE_ABI = [
  {
    type: 'function',
    name: 'finalize',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

export const PM_FINALIZE_METADATA_ABI = [
  {
    type: 'function',
    name: 'finalizeMetadata',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/// editMetadata mirrors createMarket's CreateParams tuple exactly.
/// Field order MUST match _validateCreate's calldata layout, otherwise
/// the selector drifts. Pin test compares the selector against the
/// hardcoded literal below.
export const PM_EDIT_METADATA_ABI = [
  {
    type: 'function',
    name: 'editMetadata',
    inputs: [
      { name: 'marketId', type: 'uint256' },
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'shape', type: 'uint8' },
          { name: 'stakingOpensAt', type: 'uint64' },
          { name: 'closeAt', type: 'uint64' },
          { name: 'title', type: 'bytes' },
          { name: 'description', type: 'bytes' },
          { name: 'streamUrl', type: 'bytes' },
          { name: 'optionLabels', type: 'bytes[]' },
          { name: 'participantWallets', type: 'address[]' },
          { name: 'allowlist', type: 'address[]' },
          { name: 'viewMode', type: 'uint8' },
          { name: 'participationMode', type: 'uint8' },
          { name: 'perStakeMin', type: 'uint256' },
          { name: 'perStakeMax', type: 'uint256' },
          { name: 'perWalletCumulativeMax', type: 'uint256' },
          { name: 'fixedStake', type: 'uint256' },
          { name: 'winnersCount', type: 'uint8' },
          { name: 'clientNonce', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/// Pinned selectors. Each test compares the runtime computation to a
/// hardcoded literal so an ABI typo OR a contract rename trips the
/// `aa-call-allowlist-selectors.test.ts` regression gate. Computed
/// once at module load via viem's `toFunctionSelector`.
export const PM_BET_SELECTOR: Hex = toFunctionSelector(PM_BET_ABI[0]);
export const PM_STAKE_SELECTOR: Hex = toFunctionSelector(PM_STAKE_ABI[0]);
/// NOTE: PM `claim(uint256)` and v4 `claim(uint256)` share the same
/// signature → same 4-byte selector (0x379607f5). The send-time dispatcher
/// in aa-call-allowlist.ts discriminates by `wrapper.to`: PM_CONTRACT_ADDRESS
/// routes to assertPmClaimCall; MAKO_ADDRESS routes to assertClaimCall.
export const PM_CLAIM_SELECTOR: Hex = toFunctionSelector(PM_CLAIM_ABI[0]);
export const PM_CANCEL_SELECTOR: Hex = toFunctionSelector(PM_CANCEL_ABI[0]);
export const PM_RESOLVE_SELECTOR: Hex = toFunctionSelector(PM_RESOLVE_ABI[0]);
export const PM_CONFIRM_SELECTOR: Hex = toFunctionSelector(PM_CONFIRM_ABI[0]);
export const PM_DISTRIBUTE_SELECTOR: Hex = toFunctionSelector(
  PM_DISTRIBUTE_ABI[0],
);
export const PM_FINALIZE_SELECTOR: Hex = toFunctionSelector(
  PM_FINALIZE_ABI[0],
);
export const PM_FINALIZE_METADATA_SELECTOR: Hex = toFunctionSelector(
  PM_FINALIZE_METADATA_ABI[0],
);
export const PM_EDIT_METADATA_SELECTOR: Hex = toFunctionSelector(
  PM_EDIT_METADATA_ABI[0],
);
