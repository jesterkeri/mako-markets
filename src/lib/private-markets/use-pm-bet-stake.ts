'use client';

// ----------------------------------------------------------------------------
// src/lib/private-markets/use-pm-bet-stake.ts
//
// Phase 2E-2 slice 1: usePmBet + usePmStake — dual-path (Magic + wallet)
// hooks for Friendly bet and Vote-shape stake against
// MakoPrivateMarketsV1. Mirrors usePlaceBet (src/lib/hooks.ts) but
// targets the PM contract.
//
// Architecture:
//
//   submit({ marketId, side|optionIndex, amount })
//     │
//     ├─ Magic branch:
//     │   1. wagmi useReadContract: allowance(safe, PM_CONTRACT_ADDRESS)
//     │   2. runPmBet / runPmStake({ ..., currentAllowance })
//     │      Orchestrator picks single-call vs batched internally
//     │      based on currentAllowance >= amount.
//     │   3. Outcome switch (sent / submitted / reverted / etc).
//     │
//     └─ Wallet branch:
//         0. Identity guard (connectedAddress matches session).
//         1. ensureMonadChain.
//         2. publicClient.readContract: allowance(wallet, PM_CONTRACT_ADDRESS).
//         3. If allowance < amount:
//            a. writeContractAsync approve(PM, MaxUint256).
//            b. waitForTransactionReceipt.
//         4. publicClient.simulateContract: bet/stake (catches reverts
//            before signing the action tx).
//         5. writeContractAsync bet/stake.
//         6. waitForTransactionReceipt.
//
// Phase state machine (PmActionPhase below) mirrors PlaceBetPhase.
//
// Single hook surface for both bet (Friendly) and stake (Vote shapes)
// keeps the BetSheet integration symmetric. The form dispatches based
// on the market's shape: shape === 0 → usePmBet; shape ∈ {1, 2} →
// usePmStake.
// ----------------------------------------------------------------------------

import { useCallback, useRef, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi';
import {
  decodeErrorResult,
  maxUint256,
  type Address,
  type Hex,
  type WriteContractParameters,
} from 'viem';

import { runPmBet, runPmStake, type RunOutcome } from '@/lib/aa-client';
import { monadTestnet, MONAD_TESTNET_ID } from '@/lib/chain';
import { PM_CONTRACT_ADDRESS } from '@/lib/contract';
import { useEnsureMonadChain } from '@/lib/hooks';
import { useUser } from '@/lib/use-user';
import { USDC_ADDRESS, usdcContract } from '@/lib/usdc';

import { PM_BET_ABI, PM_STAKE_ABI } from './abi-fragments';
import { isWalletIdentityAligned } from './identity-guard';

/// Phase state machine. Mirrors PlaceBetPhase from v4 hooks.ts:
///   - idle               → before any submit
///   - preparing          → chain check + allowance read
///   - approving          → wallet-only: user signing approve tx
///   - awaitingApprove    → wallet-only: waiting for approve receipt
///   - submitting         → Magic: sponsor+sign+send. Wallet: signing action tx
///   - awaitingAction     → Magic+wallet: waiting for receipt
///   - submitted          → Magic: bundler accepted, receipt poll timed out
///   - success            → terminal happy
///   - error              → terminal sad (see error state)
export type PmActionPhase =
  | 'idle'
  | 'preparing'
  | 'approving'
  | 'awaitingApprove'
  | 'submitting'
  | 'awaitingAction'
  | 'submitted'
  | 'success'
  | 'error';

export interface UsePmBetArgs {
  marketId: bigint;
  /// 0 = NO, 1 = YES (Friendly only).
  side: 0 | 1;
  /// USDC base-units (6 decimals).
  amount: bigint;
}

export interface UsePmStakeArgs {
  marketId: bigint;
  optionIndex: bigint;
  amount: bigint;
}

export interface UsePmActionState {
  phase: PmActionPhase;
  error: Error | null;
  approveHash?: Hex;
  actionHash?: Hex;
  /// 'magic' | 'wallet' | 'loading' — tells the UI which copy / button
  /// layout to render BEFORE the user clicks submit.
  flow: 'magic' | 'wallet' | 'loading';
}

export interface UsePmBet extends UsePmActionState {
  submit: (args: UsePmBetArgs) => Promise<void>;
  reset: () => void;
}

export interface UsePmStake extends UsePmActionState {
  submit: (args: UsePmStakeArgs) => Promise<void>;
  reset: () => void;
}

// ── Shared internal helpers ─────────────────────────────────────────────────

/// Resolve the address whose allowance we need to read. Magic users:
/// the Safe. Wallet users: the connected wallet. Returns undefined when
/// neither is available (e.g., during the brief render where session is
/// loading or no wallet is connected).
function useAllowanceOwner(): Address | undefined {
  const { user } = useUser();
  const { address: connectedAddress } = useAccount();
  if (user?.authType === 'magic') return user.safeAddress as Address;
  if (user?.authType === 'wallet') return connectedAddress;
  return connectedAddress; // pre-auth wallet only
}

/// wagmi useReadContract for USDC.allowance(owner, PM_CONTRACT_ADDRESS).
/// Auto-refetches on every block per wagmi's default. The Magic flow
/// passes the result through to runPmBet/runPmStake; the wallet flow
/// uses publicClient.readContract for a fresh point-in-time read at
/// submit time (the wagmi value can be stale by 1-2 blocks under
/// load).
export function usePmUsdcAllowance(): bigint | undefined {
  const owner = useAllowanceOwner();
  const { data } = useReadContract({
    ...usdcContract,
    functionName: 'allowance',
    args: owner ? [owner, PM_CONTRACT_ADDRESS] : undefined,
    query: { enabled: owner !== undefined },
  });
  return data as bigint | undefined;
}

/// Translate viem write-error messages into short user-facing strings.
/// Same pattern as the v4 `friendlyWalletError` in use-create-market.ts.
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

/// Walk the viem error chain for a typed contract error name. Returns
/// undefined when the revert wasn't a typed contract error.
function decodeContractError(
  e: unknown,
  abi: typeof PM_BET_ABI | typeof PM_STAKE_ABI,
): string | undefined {
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
        // ABI doesn't carry the matching fragment — fall through.
      }
    }
    cur = obj.cause;
  }
  return undefined;
}

/// Map a Magic-flow RunOutcome to a phase + error update. Used by both
/// usePmBet and usePmStake — the outcome union is identical because
/// both orchestrators delegate to runSponsoredCallOp.
function applyMagicOutcome(
  outcome: RunOutcome,
  setters: {
    setPhase: (p: PmActionPhase) => void;
    setError: (e: Error | null) => void;
    setActionHash: (h: Hex | undefined) => void;
  },
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
            : 'Transaction reverted on chain. Your USDC is safe; please retry after refreshing.',
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
              ? `Action rejected by sponsorship policy${outcome.reason ? ` (${outcome.reason})` : ''}.`
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

// ── usePmBet ────────────────────────────────────────────────────────────────

export function usePmBet(): UsePmBet {
  const { user, isLoading: userLoading } = useUser();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { address: connectedAddress } = useAccount();

  const [phase, setPhase] = useState<PmActionPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [approveHash, setApproveHash] = useState<Hex | undefined>();
  const [actionHash, setActionHash] = useState<Hex | undefined>();
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setApproveHash(undefined);
    setActionHash(undefined);
  }, []);

  const submit = useCallback(
    async (args: UsePmBetArgs): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setApproveHash(undefined);
      setActionHash(undefined);
      setPhase('preparing');

      try {
        if (!publicClient) {
          throw new Error('RPC client not ready — please retry.');
        }
        if (userLoading) {
          throw new Error('Session still loading. Try again in a moment.');
        }

        // ── Magic branch ────────────────────────────────────────────────
        if (user?.authType === 'magic') {
          const safeAddress = user.safeAddress as Address;
          const magicEoa = user.magicEoa as Address;
          const currentAllowance = (await publicClient.readContract({
            ...usdcContract,
            functionName: 'allowance',
            args: [safeAddress, PM_CONTRACT_ADDRESS],
          })) as bigint;

          setPhase('submitting');
          const outcome = await runPmBet({
            chainId: MONAD_TESTNET_ID,
            pmAddress: PM_CONTRACT_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            magicEoa,
            marketId: args.marketId,
            side: args.side,
            amount: args.amount,
            currentAllowance,
          });
          setPhase('awaitingAction');
          applyMagicOutcome(outcome, { setPhase, setError, setActionHash });
          return;
        }

        // ── Wallet branch ──────────────────────────────────────────────
        if (!connectedAddress) {
          throw new Error(
            'Connect a wallet or sign in with email to place a bet.',
          );
        }
        if (
          user?.authType === 'wallet' &&
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

        const walletAllowance = (await publicClient.readContract({
          ...usdcContract,
          functionName: 'allowance',
          args: [connectedAddress, PM_CONTRACT_ADDRESS],
        })) as bigint;

        if (walletAllowance < args.amount) {
          setPhase('approving');
          const aHash = await writeContractAsync({
            ...usdcContract,
            functionName: 'approve',
            args: [PM_CONTRACT_ADDRESS, maxUint256],
          });
          setApproveHash(aHash);
          setPhase('awaitingApprove');
          const approveReceipt = await publicClient.waitForTransactionReceipt({
            hash: aHash,
          });
          if (approveReceipt.status !== 'success') {
            throw new Error('USDC approval failed on-chain.');
          }
        }

        // Simulate before signing — surfaces typed reverts (WrongShape,
        // StakingNotOpen, etc.) without burning a wallet sig.
        let simRequest: WriteContractParameters;
        try {
          const sim = await publicClient.simulateContract({
            abi: PM_BET_ABI,
            address: PM_CONTRACT_ADDRESS,
            functionName: 'bet',
            args: [args.marketId, args.side, args.amount],
            account: connectedAddress as Address,
          });
          simRequest = sim.request as WriteContractParameters;
        } catch (e) {
          const decoded = decodeContractError(e, PM_BET_ABI);
          throw new Error(
            decoded
              ? `Contract rejected the bet: ${decoded}`
              : friendlyWalletError(e as Error),
          );
        }

        setPhase('submitting');
        const bHash = await writeContractAsync(simRequest);
        setActionHash(bHash);
        setPhase('awaitingAction');

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: bHash,
        });
        if (receipt.status !== 'success') {
          throw new Error(
            'Bet failed after confirmation. Your USDC approval is preserved — retry without re-approving.',
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
    [
      publicClient,
      user,
      userLoading,
      connectedAddress,
      ensureChain,
      writeContractAsync,
    ],
  );

  const flow: 'magic' | 'wallet' | 'loading' = userLoading
    ? 'loading'
    : user?.authType === 'magic'
      ? 'magic'
      : 'wallet';

  return { phase, error, approveHash, actionHash, flow, submit, reset };
}

// ── usePmStake ──────────────────────────────────────────────────────────────

export function usePmStake(): UsePmStake {
  const { user, isLoading: userLoading } = useUser();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { address: connectedAddress } = useAccount();

  const [phase, setPhase] = useState<PmActionPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [approveHash, setApproveHash] = useState<Hex | undefined>();
  const [actionHash, setActionHash] = useState<Hex | undefined>();
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setApproveHash(undefined);
    setActionHash(undefined);
  }, []);

  const submit = useCallback(
    async (args: UsePmStakeArgs): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setError(null);
      setApproveHash(undefined);
      setActionHash(undefined);
      setPhase('preparing');

      try {
        if (!publicClient) {
          throw new Error('RPC client not ready — please retry.');
        }
        if (userLoading) {
          throw new Error('Session still loading. Try again in a moment.');
        }

        if (user?.authType === 'magic') {
          const safeAddress = user.safeAddress as Address;
          const magicEoa = user.magicEoa as Address;
          const currentAllowance = (await publicClient.readContract({
            ...usdcContract,
            functionName: 'allowance',
            args: [safeAddress, PM_CONTRACT_ADDRESS],
          })) as bigint;

          setPhase('submitting');
          const outcome = await runPmStake({
            chainId: MONAD_TESTNET_ID,
            pmAddress: PM_CONTRACT_ADDRESS,
            usdcAddress: USDC_ADDRESS,
            magicEoa,
            marketId: args.marketId,
            optionIndex: args.optionIndex,
            amount: args.amount,
            currentAllowance,
          });
          setPhase('awaitingAction');
          applyMagicOutcome(outcome, { setPhase, setError, setActionHash });
          return;
        }

        if (!connectedAddress) {
          throw new Error(
            'Connect a wallet or sign in with email to stake.',
          );
        }
        if (
          user?.authType === 'wallet' &&
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

        const walletAllowance = (await publicClient.readContract({
          ...usdcContract,
          functionName: 'allowance',
          args: [connectedAddress, PM_CONTRACT_ADDRESS],
        })) as bigint;

        if (walletAllowance < args.amount) {
          setPhase('approving');
          const aHash = await writeContractAsync({
            ...usdcContract,
            functionName: 'approve',
            args: [PM_CONTRACT_ADDRESS, maxUint256],
          });
          setApproveHash(aHash);
          setPhase('awaitingApprove');
          const approveReceipt = await publicClient.waitForTransactionReceipt({
            hash: aHash,
          });
          if (approveReceipt.status !== 'success') {
            throw new Error('USDC approval failed on-chain.');
          }
        }

        let simRequest: WriteContractParameters;
        try {
          const sim = await publicClient.simulateContract({
            abi: PM_STAKE_ABI,
            address: PM_CONTRACT_ADDRESS,
            functionName: 'stake',
            args: [args.marketId, args.optionIndex, args.amount],
            account: connectedAddress as Address,
          });
          simRequest = sim.request as WriteContractParameters;
        } catch (e) {
          const decoded = decodeContractError(e, PM_STAKE_ABI);
          throw new Error(
            decoded
              ? `Contract rejected the stake: ${decoded}`
              : friendlyWalletError(e as Error),
          );
        }

        setPhase('submitting');
        const sHash = await writeContractAsync(simRequest);
        setActionHash(sHash);
        setPhase('awaitingAction');

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: sHash,
        });
        if (receipt.status !== 'success') {
          throw new Error(
            'Stake failed after confirmation. Your USDC approval is preserved — retry without re-approving.',
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
    [
      publicClient,
      user,
      userLoading,
      connectedAddress,
      ensureChain,
      writeContractAsync,
    ],
  );

  const flow: 'magic' | 'wallet' | 'loading' = userLoading
    ? 'loading'
    : user?.authType === 'magic'
      ? 'magic'
      : 'wallet';

  return { phase, error, approveHash, actionHash, flow, submit, reset };
}
