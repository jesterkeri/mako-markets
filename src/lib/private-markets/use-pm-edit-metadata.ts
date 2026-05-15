'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-pm-edit-metadata.ts
//
// Phase 2E-2 slice 4: usePmEditMetadata. Creator-only metadata rewrite
// for an existing PM market, pre-stakingOpensAt.
//
// Args:
//   - marketId: bigint
//   - params: PmCreateParamsTuple — the FULL new params (17 fields)
//
// The contract enforces:
//   - creator equality (msg.sender == m.creator)
//   - shape immutability (m.shape == p.shape)
//   - pre-staking window (block.timestamp < m.stakingOpensAt)
//   - full _validateCreate(p) body validation
//
// The hook delegates to `usePmSingleArgAction` like the other PM
// action hooks. The caller is responsible for assembling `params` —
// typically by reading the existing market state, overlaying the
// user's edits, and either reusing the existing clientNonce or
// generating a new one (the contract overwrites whichever is sent).
// ----------------------------------------------------------------------------

import {
  runPmEditMetadata,
  type RunOutcome,
} from '@/lib/aa-client';
import type { Address } from 'viem';

import {
  PM_EDIT_METADATA_ABI,
  type PmCreateParamsTuple,
} from './abi-fragments';
import {
  usePmSingleArgAction,
  type PmSingleArgActionResult,
} from './use-pm-single-arg-action';

export interface UsePmEditMetadataArgs {
  marketId: bigint;
  /// Full replacement params. The caller assembles this; typically by
  /// reading the existing market and overlaying the user's edits. The
  /// contract enforces shape immutability so `params.shape` MUST match
  /// the existing market's shape — the hook does not pre-check this
  /// (consumer should validate before calling submit).
  params: PmCreateParamsTuple;
}

export type UsePmEditMetadata = PmSingleArgActionResult<UsePmEditMetadataArgs>;

export function usePmEditMetadata(): UsePmEditMetadata {
  return usePmSingleArgAction<UsePmEditMetadataArgs>({
    actionNoun: 'Edit metadata',
    walletAbi: PM_EDIT_METADATA_ABI,
    walletFunctionName: 'editMetadata',
    buildWalletArgs: (args) => [args.marketId, args.params],
    callMagicOrchestrator: async ({
      args,
      chainId,
      pmAddress,
      magicEoa,
    }): Promise<RunOutcome> => {
      return runPmEditMetadata({
        chainId,
        pmAddress: pmAddress as Address,
        magicEoa,
        marketId: args.marketId,
        params: args.params,
      });
    },
  });
}
