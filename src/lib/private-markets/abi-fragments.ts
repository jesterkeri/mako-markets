// ----------------------------------------------------------------------------
// src/lib/private-markets/abi-fragments.ts
//
// Phase 2C-1: createMarket ABI fragment + 4-byte selector for the
// MakoPrivateMarketsV1 contract. The fragment is the source of truth
// for both encode-side (aa-client.ts: runCreatePrivateMarket) and
// decode-side (aa-call-allowlist.ts: assertPmCreateMarketCall) of the
// userOp pipeline.
//
// The CreateParams tuple has 17 fields in struct order per
// MakoPrivateMarketsV1.sol lines 189-207. Field order MUST match the
// Solidity struct exactly — the compiler emits args by struct order,
// not by name, so a re-ordered fragment produces a different
// selector. The aa-call-allowlist-selectors.test.ts test guards
// against drift by comparing PM_CREATE_MARKET_SELECTOR against a
// hardcoded hex literal.
//
// PmCreateParamsTuple is the object-form callers use (browser + server
// share this). viem's encodeFunctionData/decodeFunctionData accept
// the named-field form for `tuple` ABI types.
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
