'use client';

import { useCallback, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, maxUint256 } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';

import type { ConfirmPhase } from '@/components/ConfirmSheet';
import { buildBetBody, buildClaimBody, runSponsoredRequest } from './aa-client';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import { phaseFromOutcome, refusalPhase, type OutcomeWords } from './confirm-outcome';
import { MAKO_ADDRESS, makoContract } from './contract';
import { useEnsureMonadChain } from './hooks';
import { USDC_ADDRESS, usdcContract } from './usdc';
import { useUser } from './use-user';

// One on-chain pool action (a bet or a claim) driven through the confirm sheet (19a). An email account's action is
// gas-free: one signature from its embedded wallet, sponsored by Mako Market. A wallet account signs and pays its
// own gas: an approval first if the allowance is short, then the action, each checked by simulation before the
// wallet is asked.

export type PoolTx = { kind: 'bet'; marketId: bigint; isYes: boolean; amount: bigint } | { kind: 'claim'; marketId: bigint };

const WORDS: Record<PoolTx['kind'], OutcomeWords> = {
  bet: { noun: 'bet', failTitle: "Bet didn't go through" },
  claim: { noun: 'claim', failTitle: "Claim didn't go through" },
};

function isUserRejection(err: unknown): boolean {
  const text = err instanceof BaseError ? `${err.shortMessage} ${err.details ?? ''}` : String((err as Error)?.message ?? err);
  return /user rejected|user denied|rejected the request/i.test(text);
}

function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | undefined;
  return reverted ? (reverted.data?.errorName ?? reverted.reason ?? undefined) : undefined;
}

/// A transaction Monad mined and reverted: its effects were undone, so no USDC moved (the wallet paid the gas).
function undone(w: OutcomeWords, body = `Monad turned the ${w.noun} down, so it was undone. The pool may have changed; check it and try again.`): ConfirmPhase {
  return { step: 'failed', title: w.failTitle, body, nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
}

export function usePoolTx(onLanded?: () => void) {
  const { user } = useUser();
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const [tx, setTx] = useState<PoolTx | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>({ step: 'review' });
  const inFlight = useRef(false);

  /// Opens the sheet on the review step.
  const open = useCallback((next: PoolTx) => {
    if (inFlight.current) return;
    setTx(next);
    setPhase({ step: 'review' });
  }, []);

  /// Closes the sheet; never while a transaction is on its way.
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
      if (user.authType === 'magic') {
        setPhase({ step: 'pending', stage: 'signing' });
        const onStage = (stage: 'signing' | 'sending' | 'confirming') => setPhase({ step: 'pending', stage });
        const magicEoa = user.magicEoa as `0x${string}`;
        let body;
        if (tx.kind === 'bet') {
          const currentAllowance = (await publicClient.readContract({
            ...usdcContract,
            functionName: 'allowance',
            args: [user.safeAddress as `0x${string}`, MAKO_ADDRESS],
          })) as bigint;
          body = buildBetBody({ chainId: MONAD_TESTNET_ID, marketId: tx.marketId, isYes: tx.isYes, amountUsdc: tx.amount, usdcAddress: USDC_ADDRESS, makoAddress: MAKO_ADDRESS, currentAllowance });
        } else {
          body = buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: tx.marketId });
        }
        next = phaseFromOutcome(await runSponsoredRequest(body, magicEoa, onStage), words);
      } else {
        next = await runWithWallet(tx, words);
      }
    } catch (err) {
      // Only reached before anything was signed for an email account (the allowance read), or on a wallet error
      // the wallet flow did not classify.
      next = isUserRejection(err)
        ? { step: 'cancelled' }
        : { step: 'failed', title: words.failTitle, body: "Something went wrong before it was sent. Check Me before you try again.", nothingMoved: false, primary: { label: 'Check Me', href: '/me' }, secondary: { label: 'Close' } };
    } finally {
      inFlight.current = false;
    }
    setPhase(next);
    if (next.step === 'done') onLanded?.();

    async function runWithWallet(t: PoolTx, w: OutcomeWords): Promise<ConfirmPhase> {
      const account = connected;
      if (!account || !publicClient) {
        return { step: 'failed', title: 'Wallet not connected', body: 'Connect the wallet you signed in with, then try again.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
      }
      setPhase({ step: 'pending', stage: 'signing' });
      try {
        await ensureChain();
      } catch {
        return { step: 'cancelled' };
      }
      /// Set once the action itself is handed to the wallet: from then on an error other than a refusal may come
      /// after the wallet broadcast it, so the sheet can no longer say nothing moved.
      let sent = false;
      try {
        if (t.kind === 'bet') {
          const allowance = (await publicClient.readContract({ ...usdcContract, functionName: 'allowance', args: [account, MAKO_ADDRESS] })) as bigint;
          if (allowance < t.amount) {
            const approveHash = await writeContractAsync({ ...usdcContract, functionName: 'approve', args: [MAKO_ADDRESS, maxUint256], chainId: monadTestnet.id });
            setPhase({ step: 'pending', stage: 'confirming', txHash: approveHash });
            const approved = await publicClient.waitForTransactionReceipt({ hash: approveHash });
            if (approved.status !== 'success') return undone(w, 'Your USDC approval was turned down on Monad, so the bet was not sent.');
          }
          try {
            await publicClient.simulateContract({ ...makoContract, functionName: 'placeBet', args: [t.marketId, t.isYes, t.amount], account });
          } catch (err) {
            return refusalPhase(revertName(err), w);
          }
          setPhase({ step: 'pending', stage: 'signing' });
          sent = true;
          const hash = await writeContractAsync({ ...makoContract, functionName: 'placeBet', args: [t.marketId, t.isYes, t.amount], chainId: monadTestnet.id });
          setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          return receipt.status === 'success' ? { step: 'done', txHash: hash } : undone(w);
        }
        try {
          await publicClient.simulateContract({ ...makoContract, functionName: 'claim', args: [t.marketId], account });
        } catch (err) {
          return refusalPhase(revertName(err), w);
        }
        sent = true;
        const hash = await writeContractAsync({ ...makoContract, functionName: 'claim', args: [t.marketId], chainId: monadTestnet.id });
        setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return receipt.status === 'success' ? { step: 'done', txHash: hash } : undone(w);
      } catch (err) {
        if (isUserRejection(err)) return { step: 'cancelled' };
        return sent
          ? { step: 'failed', title: 'Lost track of it', body: `Your ${w.noun} may have been sent, but its confirmation didn't come back. Check Me before you try again.`, nothingMoved: false, primary: { label: 'Check Me', href: '/me' }, secondary: { label: 'Close' } }
          : { step: 'failed', title: w.failTitle, body: 'Your wallet or the network failed before it was sent.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
      }
    }
  }, [tx, user, connected, publicClient, writeContractAsync, ensureChain, onLanded]);

  return { tx, phase, open, close, confirm: run, retry: run };
}
