'use client';

import { useCallback, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';

import type { ConfirmPhase } from '@/components/ConfirmSheet';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import { phaseFromOutcome, refusalPhase, type OutcomeWords } from './confirm-outcome';
import { ROUNDS_ADDRESS } from './contract';
import { useEnsureMonadChain } from './hooks';
import { roundsAbi } from './rounds-abi';
import { runClaimRound, runEnterRound, runRefundRound, runScheduleRound } from './rounds-client';
import type { RoundSide } from './rounds-model';
import { usdcContract } from './usdc';
import { formatAddress } from './user-display';
import { useUser, type AuthedUser } from './use-user';
import { isWalletDrifted } from './wallet-drift';

// One Rounds action driven through the confirm sheet (19a), the way usePoolTx drives a pool action. An email
// account's action is gas-free through the sponsor (rounds-client.ts). A wallet account signs and pays its own gas:
// an approval of exactly the stake first when its allowance is short (never unlimited, as the sponsored path), then
// the action, each checked by simulation before the wallet is asked.

export type RoundTx =
  | { kind: 'enter'; roundId: bigint; side: RoundSide; amount: bigint }
  | { kind: 'claim'; roundId: bigint }
  /// Marks a round refunded once it qualifies (one side empty at entry close, or no price 24H after the close).
  | { kind: 'refund'; roundId: bigint }
  | { kind: 'schedule'; startTime: bigint };

const WORDS: Record<RoundTx['kind'], OutcomeWords> = {
  enter: { noun: 'prediction', failTitle: "Prediction didn't go through", afterRevert: 'The round may have changed; check it and try again.' },
  claim: { noun: 'claim', failTitle: "Claim didn't go through", afterRevert: 'Check the round and try again.' },
  refund: { noun: 'refund', failTitle: "Refund didn't go through", afterRevert: 'Check the round and try again.' },
  schedule: { noun: 'round', failTitle: "The round wasn't scheduled", afterRevert: 'Check the start time and try again.' },
};

/// MakoRoundsV1's refusals, in the round page's words. Nothing was sent, so nothing moved.
const ROUND_REFUSALS: Record<string, [string, string]> = {
  EntriesClosed: ['Predictions closed first', 'The round stopped taking predictions before yours reached Monad.'],
  BelowMinimumEntry: ['Below the minimum', 'The minimum prediction is 0.10 USDC.'],
  AlreadyOnTheOtherSide: ['You picked the other side', 'One wallet can only be on one side of a round. You can add to the side you picked.'],
  RoundAlreadyTerminal: ['Round already finished', 'This round has its result, so it takes no more predictions.'],
  NothingOwed: ['Nothing to claim', 'This wallet has nothing to claim from this round, or it was already claimed.'],
  RoundNotTerminal: ['Not finished yet', 'This round has no result yet, so there is nothing to claim.'],
  NotRefundableYet: ['Not refundable yet', 'This round does not qualify for a refund yet.'],
  NotACreator: ['Not a house account', 'Rounds are hosted by the Mako Market house; this wallet is not one of its accounts.'],
  CreatorHasActiveRound: ['You already have a round', 'Each house account can have one unfinished round at a time. Schedule the next one after it settles.'],
  TooManyActiveRounds: ['All round slots are in use', 'The most rounds that can run at once are already scheduled. Try again after one settles.'],
  StartTimeNotOnBoundary: ['Pick a whole minute', 'A round must start on a whole minute.'],
  LeadTooShort: ['Too soon', 'A round must start at least 10 minutes from now.'],
  LeadTooLong: ['Too far ahead', 'A round can start at most 7 days from now.'],
  NoSuchRound: ['Round not found', 'This round does not exist.'],
};

function roundRefusal(errorName: string | undefined, w: OutcomeWords): ConfirmPhase {
  const known = errorName ? ROUND_REFUSALS[errorName] : undefined;
  if (known) return { step: 'failed', title: known[0], body: known[1], nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } };
  return refusalPhase(errorName, w);
}

function isUserRejection(err: unknown): boolean {
  const text = err instanceof BaseError ? `${err.shortMessage} ${err.details ?? ''}` : String((err as Error)?.message ?? err);
  return /user rejected|user denied|rejected the request/i.test(text);
}

function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | undefined;
  return reverted ? (reverted.data?.errorName ?? reverted.reason ?? undefined) : undefined;
}

function undone(w: OutcomeWords): ConfirmPhase {
  return { step: 'failed', title: w.failTitle, body: `Monad turned the ${w.noun} down, so it was undone. ${w.afterRevert ?? ''}`.trim(), nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
}

function wrongWallet(user: Extract<AuthedUser, { authType: 'wallet' }>, connected: string): ConfirmPhase {
  return {
    step: 'failed',
    title: 'Wrong wallet connected',
    body: `You signed in with ${formatAddress(user.walletAddress)}, but your browser wallet is ${formatAddress(connected)}. Switch your wallet to ${formatAddress(user.walletAddress)}, then try again.`,
    nothingMoved: true,
    primary: { label: 'Try again', retry: true },
    secondary: { label: 'Close' },
  };
}

const unavailable = (w: OutcomeWords): ConfirmPhase => ({ step: 'failed', title: w.failTitle, body: 'Rounds are not live right now.', nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } });

/// Once a USDC approval went out, an outcome that would say "nothing moved" says what did: the approval (it moves no
/// USDC; it lets the Rounds contract take exactly the stake later). As usePoolTx does.
function afterApproval(a: { hash: `0x${string}`; state: 'sent' | 'confirmed' }, p: ConfirmPhase, w: OutcomeWords): ConfirmPhase {
  if (p.step !== 'cancelled' && !(p.step === 'failed' && p.nothingMoved)) return p;
  const what =
    a.state === 'confirmed'
      ? 'Your USDC approval went through, so the Rounds contract can take exactly this stake when you predict.'
      : "Your USDC approval was sent, but its confirmation didn't come back.";
  const why = p.step === 'cancelled' ? `You declined the ${w.noun} in your wallet.` : `${p.title}: ${p.body}`;
  return {
    step: 'failed',
    title: `Approval sent, ${w.noun} not placed`,
    body: `${what} The ${w.noun} was not placed. ${why} No USDC left your wallet. Approval tx ${a.hash.slice(0, 10)}…`,
    nothingMoved: true,
    primary: { label: 'Try again', retry: true },
    secondary: { label: 'Close' },
  };
}

class WalletSwitched extends Error {}
const isAccountNotConnected = (err: unknown) => (err as { name?: string } | null)?.name === 'ConnectorAccountNotFoundError';

export function useRoundTx(onLanded?: () => void) {
  const { user } = useUser();
  const { address: connected } = useAccount();
  const connectedNow = useRef(connected);
  connectedNow.current = connected;
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const [tx, setTx] = useState<RoundTx | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>({ step: 'review' });
  const inFlight = useRef(false);

  const open = useCallback(
    (next: RoundTx) => {
      if (inFlight.current) return;
      setTx(next);
      setPhase(user && user.authType === 'wallet' && connected && isWalletDrifted(user, connected) ? wrongWallet(user, connected) : { step: 'review' });
    },
    [user, connected],
  );

  const close = useCallback(() => {
    if (inFlight.current) return;
    setTx(null);
    setPhase({ step: 'review' });
  }, []);

  const run = useCallback(async () => {
    if (!tx || !user || !publicClient || inFlight.current) return;
    inFlight.current = true;
    const words = WORDS[tx.kind];
    let next: ConfirmPhase;
    try {
      if (!ROUNDS_ADDRESS) next = unavailable(words);
      else if (user.authType === 'magic') next = await runSponsored(tx, user, words, ROUNDS_ADDRESS);
      else next = await runWithWallet(tx, user, words, ROUNDS_ADDRESS);
    } catch (err) {
      next = isUserRejection(err)
        ? { step: 'cancelled' }
        : { step: 'failed', title: words.failTitle, body: 'Something went wrong before it was sent. Check Me before you try again.', nothingMoved: false, primary: { label: 'Check Me', href: '/me' }, secondary: { label: 'Close' } };
    } finally {
      inFlight.current = false;
    }
    setPhase(next);
    if (next.step === 'done') onLanded?.();

    async function runSponsored(t: RoundTx, u: Extract<AuthedUser, { authType: 'magic' }>, w: OutcomeWords, rounds: `0x${string}`): Promise<ConfirmPhase> {
      setPhase({ step: 'pending', stage: 'signing' });
      const onStage = (stage: 'signing' | 'sending' | 'confirming') => setPhase({ step: 'pending', stage });
      const common = { chainId: MONAD_TESTNET_ID, magicEoa: u.magicEoa as `0x${string}`, onStage };
      let outcome;
      if (t.kind === 'enter') {
        const currentAllowance = (await publicClient!.readContract({ ...usdcContract, functionName: 'allowance', args: [u.safeAddress as `0x${string}`, rounds] })) as bigint;
        outcome = await runEnterRound({ ...common, roundId: t.roundId, side: t.side, amount: t.amount, currentAllowance });
      } else if (t.kind === 'claim') {
        outcome = await runClaimRound({ ...common, roundId: t.roundId });
      } else if (t.kind === 'refund') {
        outcome = await runRefundRound({ ...common, roundId: t.roundId });
      } else {
        outcome = await runScheduleRound({ ...common, startTime: t.startTime });
      }
      return phaseFromOutcome(outcome, w);
    }

    async function runWithWallet(t: RoundTx, u: Extract<AuthedUser, { authType: 'wallet' }>, w: OutcomeWords, rounds: `0x${string}`): Promise<ConfirmPhase> {
      const account = connected;
      if (!account || !publicClient) {
        return { step: 'failed', title: 'Wallet not connected', body: 'Connect the wallet you signed in with, then try again.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
      }
      if (isWalletDrifted(u, account)) return wrongWallet(u, account);
      const client = publicClient;
      const contract = { address: rounds, abi: roundsAbi } as const;
      /// The USDC approval, once the wallet hands back its hash: from then on no outcome may hide it (adversary on
      /// 44aa10d). `confirmed` once Monad included it; reverted approvals are dropped, they moved nothing.
      let approval: { hash: `0x${string}`; state: 'sent' | 'confirmed' } | null = null;

      async function write(request: Parameters<typeof writeContractAsync>[0]): Promise<`0x${string}`> {
        if (!connectedNow.current || isWalletDrifted(u, connectedNow.current)) throw new WalletSwitched();
        return writeContractAsync({ ...request, account: account! } as Parameters<typeof writeContractAsync>[0]);
      }

      const result = await steps();
      return approval ? afterApproval(approval, result, w) : result;

      async function steps(): Promise<ConfirmPhase> {
        setPhase({ step: 'pending', stage: 'signing' });
        try {
          await ensureChain();
        } catch {
          return { step: 'cancelled' };
        }
        let sent = false;
        try {
          if (t.kind === 'enter') {
            const allowance = (await client.readContract({ ...usdcContract, functionName: 'allowance', args: [account!, rounds] })) as bigint;
            if (allowance < t.amount) {
              // Exactly the stake, never unlimited.
              const hash = await write({ ...usdcContract, functionName: 'approve', args: [rounds, t.amount], chainId: monadTestnet.id });
              approval = { hash, state: 'sent' };
              setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
              const approved = await client.waitForTransactionReceipt({ hash });
              if (approved.status !== 'success') {
                approval = null;
                return undone({ ...w, afterRevert: 'Your USDC approval was turned down on Monad, so the prediction was not sent.' });
              }
              approval = { hash, state: 'confirmed' };
            }
          }
          const call =
            t.kind === 'enter'
              ? ({ functionName: 'enter', args: [t.roundId, t.side === 'up' ? 1 : 2, t.amount] } as const)
              : t.kind === 'claim'
                ? ({ functionName: 'claim', args: [t.roundId] } as const)
                : t.kind === 'refund'
                  ? ({ functionName: 'finalizeRefund', args: [t.roundId] } as const)
                  : ({ functionName: 'schedule', args: [t.startTime] } as const);
          try {
            await client.simulateContract({ ...contract, ...call, account: account! } as Parameters<typeof client.simulateContract>[0]);
          } catch (err) {
            return roundRefusal(revertName(err), w);
          }
          setPhase({ step: 'pending', stage: 'signing' });
          sent = true;
          const hash = await write({ ...contract, ...call, chainId: monadTestnet.id } as Parameters<typeof writeContractAsync>[0]);
          setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
          const receipt = await client.waitForTransactionReceipt({ hash });
          return receipt.status === 'success' ? { step: 'done', txHash: hash } : undone(w);
        } catch (err) {
          if (err instanceof WalletSwitched || isAccountNotConnected(err)) return wrongWallet(u, connectedNow.current ?? account!);
          if (isUserRejection(err)) return { step: 'cancelled' };
          return sent
            ? { step: 'failed', title: 'Lost track of it', body: `Your ${w.noun} may have been sent, but its confirmation didn't come back. Check Me before you try again.`, nothingMoved: false, primary: { label: 'Check Me', href: '/me' }, secondary: { label: 'Close' } }
            : { step: 'failed', title: w.failTitle, body: 'Your wallet or the network failed before it was sent.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
        }
      }
    }
  }, [tx, user, connected, publicClient, writeContractAsync, ensureChain, onLanded]);

  return { tx, phase, open, close, confirm: run, retry: run };
}
