'use client';

import { useCallback, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, maxUint256 } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';

import type { ConfirmPhase } from '@/components/ConfirmSheet';
import { buildBetBody, buildClaimBody, buildClaimCreatorFeeBody, buildCreateBody, runSponsoredRequest } from './aa-client';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import { phaseFromOutcome, refusalPhase, type OutcomeWords } from './confirm-outcome';
import { createdMarketIdFor, MAKO_ADDRESS, makoContract } from './contract';
import { clearCreatorClaimSent, creatorClaimHeld, markCreatorClaimSent } from './creator-claim-pending';
import { creatorEarningNote, creatorEarningOf, isPoolCreator } from './creator-earnings';
import { toBytes32 } from './oracle';
import { SHEET_HOLD_SEC } from './market-timing';
import { buildPool, type CreateDraft } from './pool-create';
import { decodeMarket, useEnsureMonadChain } from './hooks';
import { USDC_ADDRESS, usdcContract } from './usdc';
import { formatAddress } from './user-display';
import { accountAddress, useUser, type AuthedUser } from './use-user';
import { isWalletDrifted } from './wallet-drift';

// One on-chain pool action (a bet, a claim, a creator-fee claim or a new pool) driven through the confirm sheet
// (19a). An email account's action is gas-free: one signature from its embedded wallet, sponsored by Mako Market. A
// wallet account signs and pays its own gas: an approval first if the allowance is short, then the action, each
// checked by simulation before the wallet is asked.

export type PoolTx =
  | { kind: 'bet'; marketId: bigint; isYes: boolean; amount: bigint }
  | { kind: 'claim'; marketId: bigint }
  /// A creator's earnings on a pool it created: MakoMarketsV4.claimCreatorFee(id).
  | { kind: 'creatorFee'; marketId: bigint }
  /// A new pool: built from the draft with `nowSec`, the moment its confirm sheet opened, so the title and times sent
  /// are exactly the ones the sheet showed (they hold for SHEET_HOLD_SEC), with the creator's first bet (`seed`, at
  /// least 1 USDC) on one side.
  | { kind: 'create'; draft: CreateDraft; nowSec: number; openedAtMs: number; seed: bigint; seedYes: boolean };

const WORDS: Record<PoolTx['kind'], OutcomeWords> = {
  bet: { noun: 'bet', failTitle: "Bet didn't go through" },
  claim: { noun: 'claim', failTitle: "Claim didn't go through" },
  creatorFee: {
    noun: 'claim',
    failTitle: "Claim didn't go through",
    refusals: {
      NotAuthorized: ['Not your pool', "Only the pool's creator can claim its creator earnings."],
      BadOutcome: ['Refunded pool', 'The pool was refunded, so it pays no creator fee.'],
      NotResolved: ['Not settled yet', 'The pool has no result yet. Creator earnings can be claimed once it settles YES or NO.'],
      AlreadyClaimed: ['Already claimed', 'These creator earnings were already claimed. Check your balance.'],
    },
  },
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
  // "Not placed", not "not sent": a reverted action was sent and undone (adversary on 26a91cd).
  return {
    step: 'failed',
    title: `Approval sent, ${w.noun} not placed`,
    body: `${what} The ${w.noun} was not placed: ${why} No USDC left your wallet. Approval tx ${a.hash.slice(0, 10)}…`,
    nothingMoved: true,
    primary: { label: 'Try again', retry: true },
    secondary: { label: 'Close' },
  };
}

/// A new pool's times are fixed when its sheet opens and hold for SHEET_HOLD_SEC (naming plan r8 §7.7): past that the
/// title on chain could differ from the one confirmed, or the pool miss a margin, so nothing is read, signed or sent.
/// "Try again" re-runs with the same times, so it answers this at once; the user reopens the sheet for new times.
/// The hold is measured twice: on the wall clock against `nowSec` (the times shown), and on the browser's monotonic
/// clock against `openedAtMs` (performance.now() when the sheet opened), so a device clock moved backwards cannot
/// stretch it (Codex naming code review R1 F2).
const holdExpired = (t: { nowSec: number; openedAtMs: number }) =>
  Math.floor(Date.now() / 1000) - t.nowSec > SHEET_HOLD_SEC || performance.now() - t.openedAtMs > SHEET_HOLD_SEC * 1000;
const TIMES_MOVED_ON: ConfirmPhase = {
  step: 'failed',
  title: 'Times moved on',
  body: `A new pool's times are set when this sheet opens and hold for ${SHEET_HOLD_SEC} seconds. Close this and press Create pool again for new times.`,
  nothingMoved: true,
  primary: { label: 'Close' },
  secondary: { label: 'Close' },
};

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/// The browser wallet changed between Confirm and a wallet request: nothing was asked of it.
class WalletSwitched extends Error {}

/// wagmi's refusal when a write names an account the connector no longer has (it throws before the wallet sees it).
const isAccountNotConnected = (err: unknown) => (err as { name?: string } | null)?.name === 'ConnectorAccountNotFoundError';

/// A creator-fee claim is checked against the pool as the chain has it right before anything is signed: the
/// contract pays 0 for a forfeited fee yet still succeeds, so a page that went stale must never send one. Returns the
/// phase that refuses it, or null when it is claimable by this account. Nothing is sent either way.
async function creatorFeeRefusal(client: Client, marketId: bigint, account: string, w: OutcomeWords): Promise<ConfirmPhase | null> {
  let market;
  try {
    market = decodeMarket(await client.readContract({ ...makoContract, functionName: 'getMarket', args: [marketId] }), marketId);
  } catch {
    return { step: 'failed', title: "Couldn't check the pool", body: 'Mako Market could not read the pool from Monad, so nothing was sent. Try again in a moment.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
  }
  const refuse = (title: string, body: string): ConfirmPhase => ({ step: 'failed', title, body, nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } });
  if (!isPoolCreator(market, account)) return refuse(...w.refusals!.NotAuthorized);
  const e = creatorEarningOf(market, creatorClaimHeld(marketId));
  if (!e) return refuse('No creator fee', 'This pool pays no creator fee.');
  switch (e.state) {
    case 'claimable':
      return null;
    case 'confirming':
      return refuse('Claim already sent', 'This browser already sent the claim for these creator earnings, and Monad has not shown it here yet. Check Me in a minute.');
    case 'forfeited':
      return refuse('Creator earnings forfeited', creatorEarningNote(e));
    case 'claimed':
      return refuse(...w.refusals!.AlreadyClaimed);
    case 'refunded':
      return refuse(...w.refusals!.BadOutcome);
    case 'unresolved':
      return refuse(...w.refusals!.NotResolved);
  }
}

export function usePoolTx(onLanded?: () => void) {
  const { user } = useUser();
  const { address: connected } = useAccount();
  /// The connected wallet as of the latest render: the wallet can change while an approval confirms, after Confirm
  /// read `connected` (adversary on 26a91cd).
  const connectedNow = useRef(connected);
  connectedNow.current = connected;
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const [tx, setTx] = useState<PoolTx | null>(null);
  const [phase, setPhase] = useState<ConfirmPhase>({ step: 'review' });
  /// The account the sheet was opened for. Another account signing in before it is sent closes it, and it never confirms
  /// for anyone else (Codex CLAIM_TILE R1 F1): a sheet, and the done step after it, belong to one account.
  const account = user ? accountAddress(user) : null;
  const [owner, setOwner] = useState<string | null>(null);
  if (tx && owner !== account && phase.step !== 'pending') {
    setTx(null);
    setPhase({ step: 'review' });
  }
  /// The id of the pool a landed create made, read from its receipt (null until then, or if it could not be read).
  const [createdId, setCreatedId] = useState<bigint | null>(null);
  const inFlight = useRef(false);

  /// Opens the sheet on the review step.
  const open = useCallback(
    (next: PoolTx) => {
      if (inFlight.current) return;
      setOwner(account);
      setTx(next);
      // A drifted wallet session never reaches the review step's Confirm button.
      setPhase(user && user.authType === 'wallet' && connected && isWalletDrifted(user, connected) ? wrongWallet(user, connected) : { step: 'review' });
      setCreatedId(null);
    },
    [user, connected, account],
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
    if (!tx || !user || !publicClient || inFlight.current || accountAddress(user) !== owner) return;
    inFlight.current = true;
    const words = WORDS[tx.kind];
    let next: ConfirmPhase;
    try {
      const refused = tx.kind === 'creatorFee' ? await creatorFeeRefusal(publicClient, tx.marketId, accountAddress(user), words) : null;
      if (refused) {
        next = refused;
      } else if (user.authType === 'magic') {
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
    // A creator-fee claim that may have reached Monad holds its pool (src/lib/creator-claim-pending.ts): every outcome
    // that does not say nothing moved (still confirming, lost track, already sending, held for a check, a send whose
    // reply was lost). 'sent' and a wallet hash are held where they happen, before any wait. (Adversary r2 on e37da59.)
    if (tx.kind === 'creatorFee' && (next.step === 'done' || (next.step === 'failed' && !next.nothingMoved))) markCreatorClaimSent(tx.marketId, next.txHash ?? 'unconfirmed');
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
        if (holdExpired(t)) return TIMES_MOVED_ON;
        const built = buildPool(t.draft, t.nowSec);
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
      } else if (t.kind === 'claim') {
        body = buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: t.marketId });
      } else {
        body = buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: t.marketId });
      }
      const outcome = await runSponsoredRequest(body, u.magicEoa as `0x${string}`, onStage);
      if (t.kind === 'create' && outcome.kind === 'sent') setCreatedId(await createdIdFrom(outcome.txHash, u.safeAddress));
      // A creator-fee claim is held from the moment it is sent (src/lib/creator-claim-pending.ts): no Claim button and
      // no second send in this browser until a read shows the fee claimed. It is done only once this browser's RPC has
      // the receipt too, since the refetch that follows reads from that node. If the node is still behind after 30 s,
      // the result is not done: it says the claim was sent and is still confirming, and the hold stays (Codex
      // CREATOR_EARNINGS R1).
      if (t.kind === 'creatorFee' && outcome.kind === 'sent') {
        markCreatorClaimSent(t.marketId, outcome.txHash);
        try {
          await publicClient.waitForTransactionReceipt({ hash: outcome.txHash, timeout: 30_000 });
        } catch {
          return {
            step: 'failed',
            title: 'Claim sent, still confirming',
            body: 'Monad accepted the claim, but this page has not seen it land yet. Check Me in a minute. The Claim button stays off until it shows as claimed.',
            nothingMoved: false,
            primary: { label: 'Check Me', href: '/me' },
            secondary: { label: 'Close' },
            txHash: outcome.txHash,
          };
        }
      }
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

      /// Every wallet request goes through here: the browser wallet must still be the signed-in one at the moment of
      /// asking, and the request names that account, so wagmi refuses rather than sign from another.
      async function write(request: Parameters<typeof writeContractAsync>[0]): Promise<`0x${string}`> {
        if (!connectedNow.current || isWalletDrifted(u, connectedNow.current)) throw new WalletSwitched();
        return writeContractAsync({ ...request, account: account! } as Parameters<typeof writeContractAsync>[0]);
      }

      /// Sends the USDC approval and records it the moment the wallet hands back its hash.
      async function approve(): Promise<'ok' | 'reverted'> {
        const approveHash = await write({ ...usdcContract, functionName: 'approve', args: [MAKO_ADDRESS, maxUint256], chainId: monadTestnet.id });
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

      async function walletSteps(account: `0x${string}`, publicClient: Client): Promise<ConfirmPhase> {
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
            if (holdExpired(t)) return TIMES_MOVED_ON;
            const built = buildPool(t.draft, t.nowSec);
            if (!built.ok) return { step: 'failed', title: w.failTitle, body: built.reason, nothingMoved: true, primary: { label: 'Close' }, secondary: { label: 'Close' } };
            const args = [built.pool.mType, toBytes32(built.pool.oracleRef), built.pool.bettingCloseTime, built.pool.closeTime, built.pool.question, t.seed, t.seedYes] as const;
            const allowance = (await publicClient.readContract({ ...usdcContract, functionName: 'allowance', args: [account, MAKO_ADDRESS] })) as bigint;
            if (allowance < t.seed && (await approve()) === 'reverted') {
              return undone(w, 'Your USDC approval was turned down on Monad, so the pool was not created.');
            }
            // Again after the approval, which can take a while; an approval that landed is kept and moves no USDC.
            if (holdExpired(t)) return TIMES_MOVED_ON;
            try {
              await publicClient.simulateContract({ ...makoContract, functionName: 'createMarket', args, account });
            } catch (err) {
              return refusalPhase(revertName(err), w);
            }
            setPhase({ step: 'pending', stage: 'signing' });
            sent = true;
            const hash = await write({ ...makoContract, functionName: 'createMarket', args, chainId: monadTestnet.id });
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
            const hash = await write({ ...makoContract, functionName: 'placeBet', args: [t.marketId, t.isYes, t.amount], chainId: monadTestnet.id });
            setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            return receipt.status === 'success' ? { step: 'done', txHash: hash } : undone(w);
          }
          // A winnings claim or a creator-fee claim: one call with the pool id, simulated first.
          const fn = t.kind === 'creatorFee' ? ('claimCreatorFee' as const) : ('claim' as const);
          try {
            await publicClient.simulateContract({ ...makoContract, functionName: fn, args: [t.marketId], account });
          } catch (err) {
            return refusalPhase(revertName(err), w);
          }
          sent = true;
          const hash = await write({ ...makoContract, functionName: fn, args: [t.marketId], chainId: monadTestnet.id });
          if (t.kind === 'creatorFee') markCreatorClaimSent(t.marketId, hash);
          setPhase({ step: 'pending', stage: 'confirming', txHash: hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status === 'success') return { step: 'done', txHash: hash };
          // Turned down on Monad: the fee is still unclaimed by this claim, so its own hold goes. Another claim's hold on
          // the pool (another tab's) is named by its own transaction and stays.
          if (t.kind === 'creatorFee') clearCreatorClaimSent(t.marketId, hash);
          return undone(w);
        } catch (err) {
          // Refused before the wallet saw anything, so nothing was sent, whatever `sent` says.
          if (err instanceof WalletSwitched || isAccountNotConnected(err)) return wrongWallet(u, connectedNow.current ?? account);
          if (isUserRejection(err)) return { step: 'cancelled' };
          return sent
            ? { step: 'failed', title: 'Lost track of it', body: `Your ${w.noun} may have been sent, but its confirmation didn't come back. Check Me before you try again.`, nothingMoved: false, primary: { label: 'Check Me', href: '/me' }, secondary: { label: 'Close' } }
            : { step: 'failed', title: w.failTitle, body: 'Your wallet or the network failed before it was sent.', nothingMoved: true, primary: { label: 'Try again', retry: true }, secondary: { label: 'Close' } };
        }
      }
    }
  }, [tx, user, owner, connected, publicClient, writeContractAsync, ensureChain, onLanded, createdIdFrom]);

  return { tx, phase, createdId, open, close, confirm: run, retry: run };
}
