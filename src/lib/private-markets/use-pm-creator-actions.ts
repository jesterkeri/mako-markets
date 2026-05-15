'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-pm-creator-actions.ts
//
// Phase 2E-2 slice 3: usePmResolve + usePmConfirm + usePmDistribute +
// usePmCancel. Creator-action hooks for the four `_requireCreatorAction`
// surfaces on MakoPrivateMarketsV1:
//
//   - resolve(marketId, outcome)   Friendly only; outcome ∈ {0=NO, 1=YES}
//   - confirm(marketId)            OpenVote only
//   - distribute(marketId)         PrizePool only
//   - cancel(marketId)             any shape
//
// The contract enforces creator equality + window + state + totalStake;
// the hook surfaces a UX guard that the wallet session is aligned but
// does NOT pre-check creator identity (that's a UI concern outside the
// hook — the consumer should disable the button when the user isn't
// the creator).
//
// All four delegate to `usePmSingleArgAction`; resolve's outcome arg
// flows through `buildWalletArgs` and `callMagicOrchestrator`.
// ----------------------------------------------------------------------------

import {
  runPmCancel,
  runPmConfirm,
  runPmDistribute,
  runPmResolve,
  type RunOutcome,
} from '@/lib/aa-client';
import type { Address } from 'viem';

import {
  PM_CANCEL_ABI,
  PM_CONFIRM_ABI,
  PM_DISTRIBUTE_ABI,
  PM_RESOLVE_ABI,
} from './abi-fragments';
import {
  usePmSingleArgAction,
  type PmSingleArgActionResult,
} from './use-pm-single-arg-action';

// ── usePmResolve (Friendly creator-action with outcome) ────────────────────

export interface UsePmResolveArgs {
  marketId: bigint;
  /// 0 = NO, 1 = YES. The contract rejects any other value with
  /// InvalidOutcome (no REFUND outcome on resolve).
  outcome: 0 | 1;
}

export type UsePmResolve = PmSingleArgActionResult<UsePmResolveArgs>;

export function usePmResolve(): UsePmResolve {
  return usePmSingleArgAction<UsePmResolveArgs>({
    actionNoun: 'Resolve',
    walletAbi: PM_RESOLVE_ABI,
    walletFunctionName: 'resolve',
    buildWalletArgs: (args) => [args.marketId, args.outcome],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmResolve({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
        outcome: args.outcome,
      });
    },
  });
}

// ── usePmConfirm (OpenVote creator-action) ─────────────────────────────────

export interface UsePmConfirmArgs {
  marketId: bigint;
}

export type UsePmConfirm = PmSingleArgActionResult<UsePmConfirmArgs>;

export function usePmConfirm(): UsePmConfirm {
  return usePmSingleArgAction<UsePmConfirmArgs>({
    actionNoun: 'Confirm',
    walletAbi: PM_CONFIRM_ABI,
    walletFunctionName: 'confirm',
    buildWalletArgs: (args) => [args.marketId],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmConfirm({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
      });
    },
  });
}

// ── usePmDistribute (PrizePool creator-action) ─────────────────────────────

export interface UsePmDistributeArgs {
  marketId: bigint;
}

export type UsePmDistribute = PmSingleArgActionResult<UsePmDistributeArgs>;

export function usePmDistribute(): UsePmDistribute {
  return usePmSingleArgAction<UsePmDistributeArgs>({
    actionNoun: 'Distribute',
    walletAbi: PM_DISTRIBUTE_ABI,
    walletFunctionName: 'distribute',
    buildWalletArgs: (args) => [args.marketId],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmDistribute({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
      });
    },
  });
}

// ── usePmCancel (any-shape creator-action) ─────────────────────────────────

export interface UsePmCancelArgs {
  marketId: bigint;
}

export type UsePmCancel = PmSingleArgActionResult<UsePmCancelArgs>;

export function usePmCancel(): UsePmCancel {
  return usePmSingleArgAction<UsePmCancelArgs>({
    actionNoun: 'Cancel',
    walletAbi: PM_CANCEL_ABI,
    walletFunctionName: 'cancel',
    buildWalletArgs: (args) => [args.marketId],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmCancel({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
      });
    },
  });
}
