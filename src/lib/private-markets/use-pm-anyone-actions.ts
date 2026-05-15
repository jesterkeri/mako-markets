'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-pm-anyone-actions.ts
//
// Phase 2E-2 slice 2: usePmClaim + usePmFinalize. Anyone-can-call PM
// actions — the contract enforces all stateful gates (terminal state
// for claim, lazy-finalization preconditions for finalize). Both hooks
// take a single `marketId` argument and have no allowance handling.
//
// Thin wrappers over `usePmSingleArgAction` which carries the dual-
// path (Magic + wallet) state machine.
// ----------------------------------------------------------------------------

import {
  runPmClaim,
  runPmFinalize,
  type RunOutcome,
} from '@/lib/aa-client';
import type { Address } from 'viem';

import { PM_CLAIM_ABI, PM_FINALIZE_ABI } from './abi-fragments';
import {
  usePmSingleArgAction,
  type PmSingleArgActionResult,
} from './use-pm-single-arg-action';

export interface UsePmClaimArgs {
  marketId: bigint;
}

export type UsePmClaim = PmSingleArgActionResult<UsePmClaimArgs>;

export function usePmClaim(): UsePmClaim {
  return usePmSingleArgAction<UsePmClaimArgs>({
    actionNoun: 'Claim',
    walletAbi: PM_CLAIM_ABI,
    walletFunctionName: 'claim',
    buildWalletArgs: (args) => [args.marketId],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmClaim({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
      });
    },
    // claim is anyone-can-call on chain; we still align the wallet
    // identity with the session because a wallet-session user signing
    // with a different connected wallet is a consistency drift the UI
    // should surface.
    requireSessionWalletAlignment: true,
  });
}

export interface UsePmFinalizeArgs {
  marketId: bigint;
}

export type UsePmFinalize = PmSingleArgActionResult<UsePmFinalizeArgs>;

export function usePmFinalize(): UsePmFinalize {
  return usePmSingleArgAction<UsePmFinalizeArgs>({
    actionNoun: 'Finalize',
    walletAbi: PM_FINALIZE_ABI,
    walletFunctionName: 'finalize',
    buildWalletArgs: (args) => [args.marketId],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmFinalize({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
      });
    },
    requireSessionWalletAlignment: true,
  });
}
