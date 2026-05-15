import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/private-markets/sponsor-chain-state.ts
//
// Phase 2E-1 slice B: chain-only hydration of the per-market state a
// sponsor-time validator needs to authorize a PM action. Reads four
// views via a single multicall:
//
//   - getMarket(marketId)               → MarketView struct
//   - getMarketOptions(marketId)        → bytes[] option labels
//   - getMarketAllowlist(marketId)      → address[] allowlist
//   - getMarketParticipants(marketId)   → address[] (PrizePool only)
//
// The four are batched in one `multicall` so a single RPC roundtrip
// covers everything the stake / creator-action / editMetadata validators
// need. Treasury is intentionally NOT here — `getPmTreasuryAddress()` is
// already module-cached (process lifetime; safe to call from anywhere).
//
// Cache scope (v7 MAJ-1 fix):
//   The cache lives in a `Map<bigint, SponsorMarketStateResult>` that
//   is CREATED PER REQUEST and passed into `readSponsorMarketState`.
//   It MUST NOT be a module-level singleton: a module-level cache would
//   serve stale per-market state across requests after a Pimlico-
//   sponsored op lands on chain (or after the user got rate-limited and
//   retried). The route creates the Map once at handler entry and
//   threads it through all validator calls in the same request.
//
// Failure-bucket policy (v8 MIN-1):
//   Per-call viem multicall failures don't carry a structured revert
//   reason — `{ status: 'failure' }` is the whole signal. We treat any
//   `getMarket` failure as `market_not_found` (the only realistic
//   revert path is `MarketUnknown`). Transport-level failures
//   (RPC down, network error) propagate as throws from `multicall(...)`
//   and land in `pm_state_rpc_failure`. The other three views can only
//   fail in tandem with `getMarket`; if `getMarket` succeeds but they
//   don't, we treat the inconsistency as `pm_bad_state_shape_unknown`
//   so the operator sees a distinct reason in the route's 403.
//
// All addresses are normalized to lowercase via `normalizeAddressLower`
// before being stored in the cache — validators downstream can `===`
// directly without rerouting through the helper (per v8 MAJ-1, both
// sides of every address comparison go through the helper at SOURCE,
// not at consumer).
// ----------------------------------------------------------------------------

import type { Address, Hex } from 'viem';

import { MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { getAaPublicClient } from '@/lib/aa-public-client';
import type { SupportedAaChainId } from '@/lib/aa-config';

import { normalizeAddressLower } from './normalize';

// ── MarketState enum mirror (ABI ↔ TS) ──────────────────────────────────────
//
// MakoPrivateMarketsV1.sol declares the enum:
//   enum MarketState { Created, Open, AwaitingCreator, Resolved,
//                      EmptyPoolResolved, Canceled, TimedOut,
//                      ZeroStakeExpired }
// Solidity emits these as uint8 in ABI returns. Plan v8 MIN-2: the
// `Open`, `AwaitingCreator`, `TimedOut`, and `ZeroStakeExpired` states
// are LAZY — they are never written to storage and only surface via
// `MarketView.effectiveState`. The pin tests assert the numeric values
// against fixtures captured from real `MarketView` returns, NOT
// against on-chain storage.
export const PmMarketState = {
  Created: 0,
  Open: 1,
  AwaitingCreator: 2,
  Resolved: 3,
  EmptyPoolResolved: 4,
  Canceled: 5,
  TimedOut: 6,
  ZeroStakeExpired: 7,
} as const;

export type PmMarketStateValue =
  (typeof PmMarketState)[keyof typeof PmMarketState];

const ALL_STATE_VALUES: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

function isValidStateValue(n: number): n is PmMarketStateValue {
  return ALL_STATE_VALUES.has(n);
}

const ALL_SHAPE_VALUES: ReadonlySet<number> = new Set([0, 1, 2]);

function isValidShapeValue(n: number): n is 0 | 1 | 2 {
  return ALL_SHAPE_VALUES.has(n);
}

// ── ABI fragments ──────────────────────────────────────────────────────────

const GET_MARKET_ABI = [
  {
    type: 'function',
    name: 'getMarket',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [
      {
        name: 'v',
        type: 'tuple',
        components: [
          { name: 'creator', type: 'address' },
          { name: 'shape', type: 'uint8' },
          { name: 'clientNonce', type: 'bytes32' },
          { name: 'createdAt', type: 'uint64' },
          { name: 'stakingOpensAt', type: 'uint64' },
          { name: 'closeAt', type: 'uint64' },
          { name: 'viewMode', type: 'uint8' },
          { name: 'participationMode', type: 'uint8' },
          { name: 'storedState', type: 'uint8' },
          { name: 'effectiveState', type: 'uint8' },
          { name: 'perStakeMin', type: 'uint256' },
          { name: 'perStakeMax', type: 'uint256' },
          { name: 'perWalletCumulativeMax', type: 'uint256' },
          { name: 'fixedStake', type: 'uint256' },
          { name: 'winnersCount', type: 'uint8' },
          { name: 'totalStake', type: 'uint256' },
          { name: 'friendlyOutcome', type: 'uint8' },
          { name: 'friendlyEmptyPoolPath', type: 'bool' },
          { name: 'feeTaken', type: 'uint256' },
          { name: 'dust', type: 'uint256' },
          { name: 'metadataFrozenEmitted', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

const GET_MARKET_OPTIONS_ABI = [
  {
    type: 'function',
    name: 'getMarketOptions',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes[]' }],
    stateMutability: 'view',
  },
] as const;

const GET_MARKET_ALLOWLIST_ABI = [
  {
    type: 'function',
    name: 'getMarketAllowlist',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const;

const GET_MARKET_PARTICIPANTS_ABI = [
  {
    type: 'function',
    name: 'getMarketParticipants',
    inputs: [{ name: 'marketId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
  },
] as const;

// ── Public result shapes ────────────────────────────────────────────────────

/// Snapshot of the chain-side state every PM validator may need at
/// sponsor-time. Addresses are lowercased; numeric values are bigint
/// (uint256/uint64 from the chain). `options` is the raw bytes array
/// — validators usually only care about its LENGTH (for option-index
/// bounds), so we don't UTF-8-decode it here.
export interface SponsorMarketState {
  readonly creator: `0x${string}`;
  readonly shape: 0 | 1 | 2;
  readonly storedState: PmMarketStateValue;
  readonly effectiveState: PmMarketStateValue;
  readonly stakingOpensAt: bigint;
  readonly closeAt: bigint;
  readonly perStakeMin: bigint;
  readonly perStakeMax: bigint;
  readonly perWalletCumulativeMax: bigint;
  readonly fixedStake: bigint;
  readonly winnersCount: number;
  readonly totalStake: bigint;
  readonly metadataFrozenEmitted: boolean;
  readonly options: readonly Hex[];
  readonly allowlist: readonly `0x${string}`[];
  readonly participants: readonly `0x${string}`[];
}

/// Tagged union: success carries the snapshot; failure carries one of
/// three structured reasons so the validator can map to the appropriate
/// NotAllowedReason code without inventing one per call site.
export type SponsorMarketStateResult =
  | { readonly ok: true; readonly state: SponsorMarketState }
  | { readonly ok: false; readonly reason: 'market_not_found' }
  | { readonly ok: false; readonly reason: 'pm_state_rpc_failure' }
  | { readonly ok: false; readonly reason: 'pm_bad_state_shape_unknown' };

/// Request-scoped cache. Key = marketId (bigint). The route creates one
/// at handler entry; the helper returns the cached entry on subsequent
/// calls within the same request. NEVER stored in a module-level
/// constant — see file header for the staleness reasoning.
export type SponsorMarketStateCache = Map<bigint, SponsorMarketStateResult>;

/// Allocate a fresh cache. The sponsor route + send route MUST call this
/// at the top of every handler invocation; passing a stale cache across
/// requests would serve stale state.
export function createSponsorMarketStateCache(): SponsorMarketStateCache {
  return new Map();
}

// ── Reader ──────────────────────────────────────────────────────────────────

interface ReadArgs {
  readonly chainId: SupportedAaChainId;
  readonly marketId: bigint;
  readonly cache: SponsorMarketStateCache;
}

/// Single-shot multicall against MakoPrivateMarketsV1. Returns the cached
/// result if `cache.has(marketId)`. Otherwise performs ONE multicall,
/// stores the typed result under `marketId`, and returns it.
///
/// Failure mapping:
///   - throw from `multicall(...)`            → 'pm_state_rpc_failure'
///   - getMarket per-call status === 'failure'  → 'market_not_found'
///   - any other per-call failure (with getMarket success)
///                                              → 'pm_bad_state_shape_unknown'
///   - decode-side shape violation
///     (unknown enum, bigint type mismatch)     → 'pm_bad_state_shape_unknown'
export async function readSponsorMarketState(
  args: ReadArgs,
): Promise<SponsorMarketStateResult> {
  const cached = args.cache.get(args.marketId);
  if (cached) return cached;

  if (args.chainId !== MONAD_TESTNET_ID) {
    // The PM contract is only deployed on Monad testnet for the 2E/2F
    // window. A non-Monad call here is a misconfiguration; surface as
    // RPC failure so the caller's 403 mapping doesn't claim the market
    // is missing on the wrong chain.
    const result: SponsorMarketStateResult = {
      ok: false,
      reason: 'pm_state_rpc_failure',
    };
    args.cache.set(args.marketId, result);
    return result;
  }

  const client = getAaPublicClient(args.chainId);

  let multicallResults: readonly {
    status: 'success' | 'failure';
    result?: unknown;
    error?: unknown;
  }[];
  try {
    multicallResults = (await client.multicall({
      allowFailure: true,
      contracts: [
        {
          address: PM_CONTRACT_ADDRESS,
          abi: GET_MARKET_ABI,
          functionName: 'getMarket',
          args: [args.marketId],
        },
        {
          address: PM_CONTRACT_ADDRESS,
          abi: GET_MARKET_OPTIONS_ABI,
          functionName: 'getMarketOptions',
          args: [args.marketId],
        },
        {
          address: PM_CONTRACT_ADDRESS,
          abi: GET_MARKET_ALLOWLIST_ABI,
          functionName: 'getMarketAllowlist',
          args: [args.marketId],
        },
        {
          address: PM_CONTRACT_ADDRESS,
          abi: GET_MARKET_PARTICIPANTS_ABI,
          functionName: 'getMarketParticipants',
          args: [args.marketId],
        },
      ],
    })) as unknown as readonly {
      status: 'success' | 'failure';
      result?: unknown;
      error?: unknown;
    }[];
  } catch {
    const result: SponsorMarketStateResult = {
      ok: false,
      reason: 'pm_state_rpc_failure',
    };
    args.cache.set(args.marketId, result);
    return result;
  }

  // Pass-1: getMarket dictates market existence. Any failure here is
  // bucketed as market_not_found per the plan v8 MIN-1 decision.
  const [marketCall, optionsCall, allowlistCall, participantsCall] =
    multicallResults;

  if (marketCall.status === 'failure') {
    const result: SponsorMarketStateResult = {
      ok: false,
      reason: 'market_not_found',
    };
    args.cache.set(args.marketId, result);
    return result;
  }

  // getMarket succeeded; if any side-array failed, the chain is in a
  // shape we don't understand. Bucket distinctly so operators can tell
  // RPC inconsistency apart from a missing market.
  if (
    optionsCall.status === 'failure' ||
    allowlistCall.status === 'failure' ||
    participantsCall.status === 'failure'
  ) {
    const result: SponsorMarketStateResult = {
      ok: false,
      reason: 'pm_bad_state_shape_unknown',
    };
    args.cache.set(args.marketId, result);
    return result;
  }

  // Decode side. viem types the result based on the ABI fragment so we
  // cast through `unknown` at the seam and re-validate every field that
  // matters for downstream invariants. A defensive decode failure maps
  // to pm_bad_state_shape_unknown.
  try {
    const view = marketCall.result as {
      creator: Address;
      shape: number;
      clientNonce: Hex;
      createdAt: bigint;
      stakingOpensAt: bigint;
      closeAt: bigint;
      viewMode: number;
      participationMode: number;
      storedState: number;
      effectiveState: number;
      perStakeMin: bigint;
      perStakeMax: bigint;
      perWalletCumulativeMax: bigint;
      fixedStake: bigint;
      winnersCount: number;
      totalStake: bigint;
      friendlyOutcome: number;
      friendlyEmptyPoolPath: boolean;
      feeTaken: bigint;
      dust: bigint;
      metadataFrozenEmitted: boolean;
    };

    if (!isValidShapeValue(view.shape)) {
      throw new Error(`unknown shape enum: ${view.shape}`);
    }
    if (!isValidStateValue(view.storedState)) {
      throw new Error(`unknown storedState enum: ${view.storedState}`);
    }
    if (!isValidStateValue(view.effectiveState)) {
      throw new Error(`unknown effectiveState enum: ${view.effectiveState}`);
    }
    if (
      typeof view.stakingOpensAt !== 'bigint' ||
      typeof view.closeAt !== 'bigint' ||
      typeof view.perStakeMin !== 'bigint' ||
      typeof view.perStakeMax !== 'bigint' ||
      typeof view.perWalletCumulativeMax !== 'bigint' ||
      typeof view.fixedStake !== 'bigint' ||
      typeof view.totalStake !== 'bigint'
    ) {
      throw new Error('non-bigint numeric field in MarketView');
    }

    const options = optionsCall.result as readonly Hex[];
    const allowlistRaw = allowlistCall.result as readonly Address[];
    const participantsRaw = participantsCall.result as readonly Address[];

    const state: SponsorMarketState = {
      creator: normalizeAddressLower(view.creator),
      shape: view.shape,
      storedState: view.storedState,
      effectiveState: view.effectiveState,
      stakingOpensAt: view.stakingOpensAt,
      closeAt: view.closeAt,
      perStakeMin: view.perStakeMin,
      perStakeMax: view.perStakeMax,
      perWalletCumulativeMax: view.perWalletCumulativeMax,
      fixedStake: view.fixedStake,
      winnersCount: view.winnersCount,
      totalStake: view.totalStake,
      metadataFrozenEmitted: view.metadataFrozenEmitted,
      options,
      allowlist: allowlistRaw.map((a) => normalizeAddressLower(a)),
      participants: participantsRaw.map((a) => normalizeAddressLower(a)),
    };

    const result: SponsorMarketStateResult = { ok: true, state };
    args.cache.set(args.marketId, result);
    return result;
  } catch {
    const result: SponsorMarketStateResult = {
      ok: false,
      reason: 'pm_bad_state_shape_unknown',
    };
    args.cache.set(args.marketId, result);
    return result;
  }
}
