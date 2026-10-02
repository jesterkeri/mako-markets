'use client';

import { useCallback, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, maxUint256 } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';

import type { ConfirmPhase } from '@/components/ConfirmSheet';
import { buildBetBody, buildClaimBody, buildCreateBody, runSponsoredRequest } from './aa-client';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import { phaseFromOutcome, refusalPhase, type OutcomeWords } from './confirm-outcome';
import { createdMarketIdFor, MAKO_ADDRESS, makoContract } from './contract';
import { toBytes32 } from './oracle';
import { buildPool, type CreateDraft } from './pool-create';
import { useEnsureMonadChain } from './hooks';
import { USDC_ADDRESS, usdcContract } from './usdc';
import { formatAddress } from './user-display';
import { useUser, type AuthedUser } from './use-user';
import { isWalletDrifted } from './wallet-drift';

// One on-chain pool action (a bet or a claim) driven through the confirm sheet (19a). An email account's action is
// gas-free: one signature from its embedded wallet, sponsored by Mako Market. A wallet account signs and pays its
// own gas: an approval first if the allowance is short, then the action, each checked by simulation before the
// wallet is asked.

export type PoolTx =
  | { kind: 'bet'; marketId: bigint; isYes: boolean; amount: bigint }
  | { kind: 'claim'; marketId: bigint }
  /// A new pool: built from the draft at the moment of confirming (a price pool runs from then), with the creator's
  /// first bet (`seed`, at least 1 USDC) on one side.
  | { kind: 'create'; draft: CreateDraft; seed: bigint; seedYes: boolean };

const WORDS: Record<PoolTx['kind'], OutcomeWords> = {
  bet: { noun: 'bet', failTitle: "Bet didn't go through" },
  claim: { noun: 'claim', failTitle: "Claim didn't go through" },
  create: { noun: 'pool', failTitle: "The pool wasn't created", afterRevert: 'Check the times and try again.' },
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

/// A wallet account whose browser wallet is not the one it signed in with: nothing may be asked of the connected
/// wallet, since the sheet, balance and limits all describe the signed-in one (Codex S4 r1).
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

/// The USDC approval a wallet account sends before its first bet or pool: once it has gone out, the sheet can never
/// say nothing was sent (Codex S3 r1). An approval moves no USDC; it lets the Pools contract take the stake later.
type Approval = { hash: `0x${string}`; state: 'sent' | 'confirmed' };

function afterApproval(a: Approval, p: ConfirmPhase, w: OutcomeWords): ConfirmPhase {
  if (p.step !== 'cancelled' && !(p.step === 'failed' && p.nothingMoved)) return p;
  const what =
    a.state === 'confirmed'
      ? 'Your USDC approval went through, so Mako Market pools can use your USDC when you bet.'
      : "Your USDC approval was sent, but its confirmation didn't come back.";
  const why = p.step === 'cancelled' ? `You declined the ${w.noun} in your wallet.` : p.body;
  return {
    step: 'failed',
    title: `Approval sent, ${w.noun} not placed`,
    body: `${what} The ${w.noun} itself was not sent: ${why} No USDC left your wallet. Approval tx ${a.hash.slice(0, 10)}…`,
    nothingMoved: true,
    primary: { label: 'Try again', retry: true },
    secondary: { label: 'Close' },
  };
}

export function usePoolTx(onLanded?: () => void) {
  const { user } = useUser();
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const client = publicClient;
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const [tx, setTx] = useState<PoolTx | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>({ step: 'review' });
  /// The id of the pool a landed create made, read from its receipt (null until then, or if it could not be read).
  const [createdId, setCreatedId] = useState<bigint | null>(null);
  const inFlight = useRef(false);

  /// Opens the sheet on the review step.
  const open = useCallback(
    (next: PoolTx) => {
      if (inFlight.current) return;
      setTx(next);
      // A drifted wallet session never reaches the review step's Confirm button.
      setPhase(user && user.authType === 'wallet' && connected && isWalletDrifted(user, connected) ? wrongWallet(user, connected) : { step: 'review' });
      setCreatedId(null);
    },
    [user, connected],
  );

  /// Closes the sheet; never while a transaction is on its way.
  const close = useCallback(() => {
    if (inFlight.current) return;
    setTx(null);
    setPhase({ step: 'review' });
  }, []);

  /// The new pool's id from a landed create's receipt, pinned to the creating account (a bundle can hold other
  /// accounts' creates). The public RPC can lag the bundler by a few seconds, so this waits for the receipt.
  const createdIdFrom = useCallback(
    async (hash: `0x${string}`, creator: string): Promise<bigint | null> => {
      if (!publicClient) return null;
      try {
        return createdMarketIdFor(await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 }), creator);
      } catch {
        return null;
      }
    },
    [publicClient],
  );

  const run = useCallback(async () => {
    if (!tx || !user || !publicClient || inFlight.current) return;
    inFlight.current = true;
    const words = WORDS[tx.kind];
    let next: ConfirmPhase;
    try {
      if (user.authType === 'magic') {
        next = await runSponsored(tx, user, words);
      } else {
        next = await runWithWallet(tx, user, words);
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

    async function runSponsored(t: PoolTx, u: Extract<typeof user, { authType: 'magic' }>, w: OutcomeWords): Promise<ConfirmPhase> {
      if (!publicClient) {
        return { step: 'failed', title: w.failTitle, body: 'Monad is not reachable right now.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
      }
      setPhase({ step: 'pending', stage: 'signing' });
      const onStage = (stage: 'signing' | 'sending' | 'confirming') => setPhase({ step: 'pending', stage });
      const safeAllowance = async () =>
        (await publicClient.readContract({ ...usdcContract, functionName: 'allowance', args: [u.safeAddress as `0x${string}`, MAKO_ADDRESS] })) as bigint;
      let body;
      if (t.kind === 'create') {
        const built = buildPool(t.draft, Math.floor(Date.now() / 1000));
        if (!built.ok) {
          return { step: 'failed', title: w.failTitle, body: built.reason, nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } };
        }
        body = buildCreateBody({
          chainId: MONAD_TESTNET_ID,
          makoAddress: MAKO_ADDRESS,
          mType: built.pool.mType,
          oracleRef: toBytes32(built.pool.oracleRef),
          bettingCloseTime: built.pool.bettingCloseTime,
          closeTime: built.pool.closeTime,
          question: built.pool.question,
          creatorSeed: t.seed,
          creatorYes: t.seedYes,
          usdcAddress: USDC_ADDRESS,
          currentAllowance: await safeAllowance(),
        });
      } else if (t.kind === 'bet') {
        body = buildBetBody({ chainId: MONAD_TESTNET_ID, marketId: t.marketId, isYes: t.isYes, amountUsdc: t.amount, usdcAddress: USDC_ADDRESS, makoAddress: MAKO_ADDRESS, currentAllowance: await safeAllowance() });
      } else {
        body = buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: t.marketId });
      }
      const outcome = await runSponsoredRequest(body, u.magicEoa as `0x${string}`, onStage);
      if (t.kind === 'create' && outcome.kind === 'sent') setCreatedId(await createdIdFrom(outcome.txHash, u.safeAddress));
      return phaseFromOutcome(outcome, w);
    }

    async function runWithWallet(t: PoolTx, u: Extract<typeof user, { authType: 'wallet' }>, w: OutcomeWords): Promise<ConfirmPhase> {
      const account = connected;
      if (!account || !publicClient) {
        return { step: 'failed', title: 'Wallet not connected', body: 'Connect the wallet you signed in with, then try again.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
      }
      // Checked again at confirm time: the browser wallet can change after the sheet opened. Before any allowance
      // read, simulation or wallet request.
      if (isWalletDrifted(u, account)) return wrongWallet(u, account);
      let approval: Approval | null = null;
      const result = await walletSteps(account, publicClient);
      return approval ? afterApproval(approval, result, w) : result;

      /// Sends the USDC approval and records it the moment the wallet hands back its hash.
      async function approve(): Promise<'ok' | 'reverted'> {
        const approveHash = await writeContractAsync({ ...usdcContract, functionName: 'approve', args: [MAKO_ADDRESS, maxUint256], chainId: monadTestnet.id });
        approval = { hash: approveHash, state: 'sent' };
        setPhase({ step: 'pending', stage: 'confirming', txHash: approveHash });
        const approved = await publicClient!.waitForTransactionReceipt({ hash: approveHash });
        if (approved.status !== 'success') {
          // Reverted: its effect was undone and the wallet paid only gas; the sheet says so itself.
          approval = null;
          return 'reverted';
        }
        approval = { hash: approveHash, state: 'confirmed' };
        return 'ok';
      }

      async function walletSteps(account: `0x${string}`, publicClient: NonNullable<typeof client>): Promise<ConfirmPhase> {
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
          if (t.kind === 'create') {
            const built = buildPool(t.draft, Math.floor(Date.now() / 1000));
            if (!built.ok) return { step: 'failed', title: w.failTitle, body: built.reason, nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } };
            const args = [built.pool.mType, toBytes32(built.pool.oracleRef), built.pool.bettingCloseTime, built.pool.closeTime, built.pool.question, t.seed, t.seedYes] as const;
            const allowance = (await publicClient.readContract({ ...usdcContract, functionName: 'allowance', args: [account, MAKO_ADDRESS] })) as bigint;
            if (allowance < t.seed && (await approve()) === 'reverted') {
              return undone(w, 'Your USDC approval was turned down on Monad, so the pool was not created.');
            }
            try {
              await publicClient.simulateContract({ ...makoContract, functionName: 'createMarket', args, account });
            } catch (err) {
              return refusalPhase(revertName(err), w);
            }
            setPhase({ step: 'pending', stage: 'signing' });
            sent = true;
            const hash = await writeContractAsync({ ...makoContract, functionName: 'createMarket', args, chainId: monadTestnet.id });
            setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== 'success') return undone(w);
            setCreatedId(createdMarketIdFor(receipt, account));
            return { step: 'done', txHash: hash };
          }
          if (t.kind === 'bet') {
            const allowance = (await publicClient.readContract({ ...usdcContract, functionName: 'allowance', args: [account, MAKO_ADDRESS] })) as bigint;
            if (allowance < t.amount && (await approve()) === 'reverted') {
              return undone(w, 'Your USDC approval was turned down on Monad, so the bet was not sent.');
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
    }
  }, [tx, user, connected, publicClient, writeContractAsync, ensureChain, onLanded, createdIdFrom]);

  return { tx, phase, createdId, open, close, confirm: run, retry: run };
}
