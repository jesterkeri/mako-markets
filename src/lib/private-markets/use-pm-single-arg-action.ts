'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-pm-single-arg-action.ts
//
// Phase 2E-2: shared `usePmSingleArgAction` helper for the six PM
// action hooks that take a single `marketId` argument and have no
// allowance handling:
//
//   anyone-can-call (idempotent):
//     - claim, finalize
//   creator-action (contract enforces creator + window + state):
//     - resolve, confirm, distribute, cancel
//
// resolve carries an additional `outcome` arg — handled via the
// `walletExtraArgs` factory.
//
// Returns the same UsePmActionState surface as usePmBet/usePmStake so
// UI state machines can share rendering across all PM action hooks.
//
// What the helper does NOT cover (left to the per-hook caller):
//   - allowance reads (bet/stake only — those have their own hook)
//   - per-hook arg shape (claim takes marketId; resolve takes marketId
//     + outcome) — the caller assembles the orchestrator call and the
//     wallet writeContract args
//
// Why this exists: writing 6 separate ~250-line hooks would duplicate
// the identity-guard + ensureChain + simulate + write + receipt body
// six times. Extract once, call six times. The actual hook files
// stay small (~80 LoC each) and the shared body has one source of
// truth for the Magic-outcome → UI-state mapping.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import {
  decodeErrorResult,
  type Abi,
  type Address,
  type Hex,
  type WriteContractParameters,
} from 'viem';

import { type RunOutcome } from '@/lib/aa-client';
import { monadTestnet } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { useEnsureMonadChain } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';

import { isWalletIdentityAligned } from './identity-guard';
import type { PmActionPhase, UsePmActionState } from './use-pm-bet-stake';

/// Friendly mapper for viem write/sim errors. Mirror of the helper in
/// use-pm-bet-stake.ts. Kept duplicated rather than re-exported because
/// the bet/stake copy already has 1 user (the file itself); rule of
/// three says we extract when there's a third caller. The PM
/// single-arg surface has 6 callers but they all go through this
/// helper, so this is the second copy total — still under the rule.
function friendlyWalletError(e: Error): string {
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('user rejected') || msg.includes('user denied')) {
    return 'Rejected in wallet.';
  }
  if (msg.includes('insufficient funds')) {
    return 'Insufficient MON balance for gas.';
  }
  if (
    msg.includes('requested resource not available') ||
    msg.includes('unsupported chain') ||
    msg.includes('chain mismatch')
  ) {
    return 'Switch your wallet to Monad testnet.';
  }
  return `Error: ${e.message.slice(0, 160)}`;
}

function decodeContractError(e: unknown, abi: Abi): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const obj = cur as {
      errorName?: string;
      data?: Hex;
      cause?: unknown;
    };
    if (obj.errorName) return obj.errorName;
    if (obj.data && typeof obj.data === 'string' && obj.data.startsWith('0x')) {
      try {
        const decoded = decodeErrorResult({ abi, data: obj.data });
        if (decoded?.errorName) return decoded.errorName;
      } catch {
        // ABI doesn't carry this error fragment.
      }
    }
    cur = obj.cause;
  }
  return undefined;
}

function applyMagicOutcome(
  outcome: RunOutcome,
  setters: {
    setPhase: (p: PmActionPhase) => void;
    setError: (e: Error | null) => void;
    setActionHash: (h: Hex | undefined) => void;
  },
  contextNoun: string,
): void {
  switch (outcome.kind) {
    case 'sent':
      setters.setActionHash(outcome.txHash);
      setters.setPhase('success');
      return;
    case 'reverted':
      setters.setActionHash(outcome.txHash);
      setters.setPhase('error');
      setters.setError(
        new Error(
          outcome.failureReason
            ? `Transaction reverted on chain: ${outcome.failureReason}`
            : 'Transaction reverted on chain. Please retry.',
        ),
      );
      return;
    case 'submitted':
      setters.setPhase('submitted');
      return;
    case 'failed_pre_submit':
      setters.setPhase('error');
      setters.setError(
        new Error(`Bundler rejected: ${outcome.failureReason}`),
      );
      return;
    case 'in_progress':
      setters.setPhase('error');
      setters.setError(
        new Error(
          `Already sending — wait ${outcome.retryAfterSeconds}s and try again.`,
        ),
      );
      return;
    case 'expired':
      setters.setPhase('error');
      setters.setError(new Error('Confirmation took too long; please retry.'));
      return;
    case 'manual_review':
      setters.setPhase('error');
      setters.setError(
        new Error(
          'Operator review required. We will follow up; no action needed.',
        ),
      );
      return;
    case 'sponsor_failed':
      setters.setPhase('error');
      setters.setError(
        new Error(
          outcome.error === 'CAP_EXCEEDED'
            ? "You've reached today's sponsored-op limit. Try again tomorrow, or use a connected wallet."
            : outcome.error === 'NOT_ALLOWED'
              ? `${contextNoun} rejected by sponsorship policy${outcome.reason ? ` (${outcome.reason})` : ''}.`
              : `Sponsorship failed: ${outcome.detail ?? outcome.error}`,
        ),
      );
      return;
    case 'send_failed':
      setters.setPhase('error');
      setters.setError(
        new Error(`Send failed: ${outcome.detail ?? outcome.error}`),
      );
      return;
  }
}

interface UsePmSingleArgActionConfig<TArgs> {
  /// Human-readable noun for the action ('Claim', 'Resolve', etc.).
  /// Plugged into user-facing error copy.
  actionNoun: string;
  /// ABI used for wallet-flow simulate + write + revert decoding.
  walletAbi: Abi;
  /// Contract function name (matches the ABI).
  walletFunctionName: string;
  /// Builds the args tuple for the wallet write/simulate. Most actions
  /// return `[marketId]`; resolve returns `[marketId, outcome]`.
  buildWalletArgs: (args: TArgs) => readonly unknown[];
  /// Calls the Magic-flow orchestrator (e.g., runPmClaim). The hook
  /// passes the chainId + pmAddress + magicEoa; this factory provides
  /// the per-action args.
  callMagicOrchestrator: (args: {
    args: TArgs;
    chainId: number;
    pmAddress: Address;
    magicEoa: Address;
  }) => Promise<RunOutcome>;
  /// Whether to require an exact session-wallet match. Creator actions
  /// rely on this for the UX guard (the contract enforces the actual
  /// gate). claim/finalize don't strictly require it (anyone-can-call)
  /// but keep the check so a wallet-session user can't sign with a
  /// different connected wallet than their authed identity — that's
  /// a consistency invariant, not a contract one.
  requireSessionWalletAlignment?: boolean;
}

export interface PmSingleArgActionResult<TArgs> extends UsePmActionState {
  submit: (args: TArgs) => Promise<void>;
  reset: () => void;
}

export function usePmSingleArgAction<TArgs>(
  config: UsePmSingleArgActionConfig<TArgs>,
): PmSingleArgActionResult<TArgs> {
  const { user, isLoading: userLoading } = useUser();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { address: connectedAddress } = useAccount();

  const [phase, setPhase] = useState<PmActionPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [actionHash, setActionHash] = useState<Hex | undefined>();
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setActionHash(undefined);
  }, []);

  const submit = useCallback(
    async (args: TArgs): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setActionHash(undefined);
      setPhase('preparing');

      try {
        if (!publicClient) {
          throw new Error('RPC client not ready — please retry.');
        }
        if (userLoading) {
          throw new Error('Session still loading. Try again in a moment.');
        }

        // ── Magic branch ──────────────────────────────────────────────
        if (user?.authType === 'magic') {
          const magicEoa = user.magicEoa as Address;
          setPhase('submitting');
          const outcome = await config.callMagicOrchestrator({
            args,
            chainId: monadTestnet.id,
            pmAddress: PM_CONTRACT_ADDRESS,
            magicEoa,
          });
          setPhase('awaitingAction');
          applyMagicOutcome(
            outcome,
            { setPhase, setError, setActionHash },
            config.actionNoun,
          );
          return;
        }

        // ── Wallet branch ────────────────────────────────────────────
        if (!connectedAddress) {
          throw new Error(
            `Connect a wallet or sign in with email to ${config.actionNoun.toLowerCase()}.`,
          );
        }
        if (
          user?.authType === 'wallet' &&
          config.requireSessionWalletAlignment !== false &&
          !isWalletIdentityAligned({
            authType: 'wallet',
            sessionWalletAddress: user.walletAddress,
            connectedAddress,
          })
        ) {
          throw new Error('Connected wallet does not match signed-in wallet.');
        }
        try {
          await ensureChain();
        } catch (e) {
          throw new Error(friendlyWalletError(e as Error));
        }

        let simRequest: WriteContractParameters;
        try {
          const sim = await publicClient.simulateContract({
            abi: config.walletAbi,
            address: PM_CONTRACT_ADDRESS,
            functionName: config.walletFunctionName,
            args: config.buildWalletArgs(args),
            account: connectedAddress as Address,
          });
          simRequest = sim.request as WriteContractParameters;
        } catch (e) {
          const decoded = decodeContractError(e, config.walletAbi);
          throw new Error(
            decoded
              ? `Contract rejected the ${config.actionNoun.toLowerCase()}: ${decoded}`
              : friendlyWalletError(e as Error),
          );
        }

        setPhase('submitting');
        const hash = await writeContractAsync(simRequest);
        setActionHash(hash);
        setPhase('awaitingAction');

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
        });
        if (receipt.status !== 'success') {
          throw new Error(
            `${config.actionNoun} failed after confirmation. Please retry.`,
          );
        }
        setPhase('success');
      } catch (e) {
        setPhase('error');
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inFlightRef.current = false;
      }
    },
    [publicClient, user, userLoading, connectedAddress, ensureChain, writeContractAsync, config],
  );

  const flow: 'magic' | 'wallet' | 'loading' = userLoading
    ? 'loading'
    : user?.authType === 'magic'
      ? 'magic'
      : 'wallet';

  return { phase, error, actionHash, flow, submit, reset };
}
