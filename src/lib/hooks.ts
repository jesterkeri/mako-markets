'use client';

import { useCallback, useRef, useState } from 'react';
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWriteContract,
} from 'wagmi';
import {
  BaseError,
  ContractFunctionRevertedError,
  maxUint256,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  decodeMarketCreatedId,
  MAKO_ADDRESS,
  makoContract,
  type MarketWithId,
  type Market,
  MarketType,
  Outcome,
} from './contract';
import { USDC_ADDRESS, usdcContract } from './usdc';
import { parseUsdc } from './usdc';
import { monadTestnet, MONAD_TESTNET_ID } from './chain';
import {
  runClaim,
  runCreateMarket,
  runPlaceBet,
  type RunOutcome,
} from './aa-client';
import { useUser } from './use-user';
import { SPONSOR_CAP_PER_USER_PER_DAY } from './aa-constants';

/**
 * Pre-write chain guard.
 *
 * If the user's wallet is on a chain other than Monad testnet, a raw
 * `writeContractAsync` call fails at the EIP-1193 layer with
 * "Requested resource not available" — a cryptic error that surfaced
 * verbatim in the create flow. This helper awaits a switch first so
 * every write path lands on the right chain without each hook having
 * to duplicate the logic.
 *
 * Throws with a friendly message if the user declines the switch so
 * the UI can display something useful instead of the EIP-1193 string.
 */
export function useEnsureMonadChain() {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  return async () => {
    if (chainId === monadTestnet.id) return;
    try {
      await switchChainAsync({ chainId: monadTestnet.id });
    } catch {
      throw new Error('Switch your wallet to Monad testnet to continue.');
    }
  };
}

// ---------------------------------------------------------------
// Reads — markets
// ---------------------------------------------------------------

function decodeMarket(raw: unknown, id: bigint): MarketWithId {
  // wagmi decodes the v4 Market struct into a named-field object because
  // MakoMarkets.abi.ts has `as const` typing. Cast to our Market type and
  // copy each field by name — positional destructure would silently misread
  // after the v3→v4 struct field-order change (bettingCloseTime inserted
  // between closeTime and totalYes; fee snapshots after creatorFeeClaimed).
  const m = raw as unknown as Market;
  return {
    id,
    creator: m.creator,
    mType: m.mType as MarketType,
    oracleRef: m.oracleRef,
    question: m.question,
    createdAt: m.createdAt,
    closeTime: m.closeTime,
    bettingCloseTime: m.bettingCloseTime,
    totalYes: m.totalYes,
    totalNo: m.totalNo,
    yesBettorCount: Number(m.yesBettorCount),
    noBettorCount: Number(m.noBettorCount),
    outcome: m.outcome as Outcome,
    resolved: m.resolved,
    creatorFeeClaimed: m.creatorFeeClaimed,
    protocolFeeBpsSnapshot: Number(m.protocolFeeBpsSnapshot),
    creatorFeeBpsSnapshot: Number(m.creatorFeeBpsSnapshot),
  };
}

/**
 * Read every market from the live contract.
 *
 * Two-step batched read:
 *   1. `nextMarketId()` → total count
 *   2. `useReadContracts` with an array of `getMarket(i)` calls for i in [0, count)
 *
 * Both steps auto-refetch every 5 seconds so the feed stays live as new bets
 * and new markets land on-chain. No manual refetch needed in the UI.
 */
export function useMarkets() {
  const {
    data: nextIdBn,
    isLoading: isCountLoading,
    refetch: refetchCount,
  } = useReadContract({
    ...makoContract,
    functionName: 'nextMarketId',
    query: {
      refetchInterval: 5000,
    },
  });

  const count = nextIdBn !== undefined ? Number(nextIdBn) : 0;

  const {
    data: marketsData,
    isLoading: isMarketsLoading,
    refetch: refetchMarkets,
  } = useReadContracts({
    contracts: Array.from({ length: count }, (_, i) => ({
      ...makoContract,
      functionName: 'getMarket' as const,
      args: [BigInt(i)] as const,
    })),
    query: {
      enabled: count > 0,
      refetchInterval: 5000,
    },
  });

  const markets: MarketWithId[] = (marketsData ?? [])
    .map((result, i): MarketWithId | null => {
      if (result.status !== 'success' || !result.result) return null;
      return decodeMarket(result.result, BigInt(i));
    })
    .filter((m): m is MarketWithId => m !== null);

  return {
    markets,
    count,
    isLoading: isCountLoading || (count > 0 && isMarketsLoading),
    refetch: () => {
      refetchCount();
      refetchMarkets();
    },
  };
}

/**
 * Read a single market by id. Used by the detail page.
 */
export function useMarket(id: bigint) {
  const { data, isLoading, refetch } = useReadContract({
    ...makoContract,
    functionName: 'getMarket',
    args: [id],
    query: {
      refetchInterval: 5000,
    },
  });

  const market: MarketWithId | undefined = data ? decodeMarket(data, id) : undefined;

  return { market, isLoading, refetch };
}

// ---------------------------------------------------------------
// Reads — USDC
// ---------------------------------------------------------------

/**
 * Read a wallet's USDC balance (6-decimal base units). Refetches every 5s
 * so the BetSheet pill and portfolio surfaces stay current.
 */
export function useUsdcBalance(account?: `0x${string}`) {
  return useReadContract({
    ...usdcContract,
    functionName: 'balanceOf',
    args: account ? [account] : undefined,
    query: {
      enabled: !!account,
      refetchInterval: 5000,
    },
  });
}

/**
 * Read a wallet's USDC allowance for a spender (default: MakoMarkets).
 * BetSheet uses this to decide whether the next bet needs an approve tx.
 */
export function useUsdcAllowance(
  account?: `0x${string}`,
  spender: `0x${string}` = MAKO_ADDRESS,
) {
  return useReadContract({
    ...usdcContract,
    functionName: 'allowance',
    args: account ? [account, spender] : undefined,
    query: {
      enabled: !!account,
      refetchInterval: 5000,
    },
  });
}

// ---------------------------------------------------------------
// Writes — bet flow (external-wallet only)
// ---------------------------------------------------------------

export type PlaceBetPhase =
  | 'idle'
  | 'preparing'
  | 'approving'
  | 'awaitingApprove'
  | 'betting'
  | 'awaitingBet'
  | 'success'
  | 'error'
  /// Magic flow only. The bundler accepted the user op but the receipt
  /// poll didn't confirm within 90s. The cron resolver settles within
  /// ~5min via on-chain truth. UI treats this as a NON-BLOCKING info
  /// state — the user can dismiss + retry later, OR check /me to see if
  /// the bet eventually landed. Mirrors plan v4 §"BetSheet copy table"
  /// info-level treatment for `submitted`. Group 5 round-1 MAJOR 2 fix.
  | 'submitted';

/**
 * Decode a viem simulate/write rejection into a short user-facing message.
 *
 * Custom errors with names (`BettingClosed`, `WalletCapExceeded`, etc.)
 * surface as the error name. Unknown reverts fall back to the short
 * message. User rejections collapse to "Wallet rejected the transaction."
 */
function decodeContractError(err: unknown): Error {
  if (!(err instanceof BaseError)) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const reverted = err.walk(
    (e) => e instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | undefined;
  if (reverted) {
    const name = reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage;
    return new Error(name ? `Bet rejected: ${name}.` : 'Bet rejected by contract.');
  }
  if (/User rejected|user denied/i.test(err.shortMessage)) {
    return new Error('Wallet rejected the transaction.');
  }
  return new Error(err.shortMessage);
}

/**
 * Place a bet on a v4 market. Branches on auth mode (Phase 1D Group 5):
 *
 *   Magic-authed user (has a Safe via Phase 1A): uses the AA flow —
 *     ONE Magic signature, gas sponsored by Mako, approve+placeBet
 *     batched into a single user op when allowance is short. Returns
 *     phase 'preparing' → 'betting' → 'awaitingBet' → 'success' (no
 *     'approving' step exposed — the batched call is opaque to the UI).
 *
 *   Wallet-connected user (no Magic session): unchanged 2-tx wagmi
 *     flow — approve (if needed) + placeBet, two MetaMask popups.
 *
 * Both branches share the same `{ placeBet, phase, approveHash, betHash,
 * error, reset, flow }` return shape so BetSheet can render copy
 * conditional on `flow` without rewiring state.
 *
 * Wallet flow steps (unchanged from Phase 1C):
 *   1. ensureChain — switch wallet to Monad testnet if needed
 *   2. allowance check — approve `MaxUint256` if `allowance < amount`
 *   3. simulateContract pre-flight — surfaces v4 anti-abuse reverts
 *      with decoded error names BEFORE the user signs the bet tx
 *   4. writeContract placeBet — submit the bet
 *   5. waitForTransactionReceipt — surface mined-receipt failures
 *
 * Magic flow steps:
 *   1. Read USDC.allowance(safe, MAKO) once via the public client.
 *   2. Call runPlaceBet → /api/aa/sponsor → Magic signs → /api/aa/send.
 *   3. Translate RunOutcome → phase state.
 */
export function usePlaceBet() {
  const { user, isLoading: userLoading } = useUser();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  // Pin the public client to Monad testnet so allowance reads, simulate
  // pre-flight, and receipt waits always hit the right chain — even if
  // the wallet hasn't finished switching yet on the same render. wagmi
  // honours the chainId arg by returning the Monad-bound client
  // regardless of the currently-selected chain in the UI.
  const publicClient = usePublicClient({ chainId: monadTestnet.id });
  const { address } = useAccount();

  const [phase, setPhase] = useState<PlaceBetPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>();
  const [betHash, setBetHash] = useState<`0x${string}` | undefined>();
  // Synchronous in-flight guard. A double-click on the bet button can
  // re-enter `placeBet` before any state setter has had a chance to
  // schedule a re-render — relying on `phase` alone leaves a window
  // where two concurrent flows can both prompt the wallet. The ref is
  // mutated inside the function body, so it blocks the second call
  // synchronously.
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setApproveHash(undefined);
    setBetHash(undefined);
  }, []);

  const placeBet = useCallback(async ({
    id,
    isYes,
    amountUsdc,
  }: {
    id: bigint;
    isYes: boolean;
    amountUsdc: string;
  }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    setError(null);
    setApproveHash(undefined);
    setBetHash(undefined);
    // `preparing` covers ensureChain + allowance read — the window where
    // the hook is doing async RPC work but hasn't yet decided whether to
    // approve or simulate. BetSheet treats it as a busy phase so the
    // button disables instantly.
    setPhase('preparing');

    if (!publicClient) {
      const e = new Error('RPC client not ready — please retry.');
      setPhase('error');
      setError(e);
      inFlightRef.current = false;
      return;
    }

    // ── Magic-authed branch (Phase 1D bet flow) ────────────────────────
    // If the user has a Magic session (and thus a derived Safe), route
    // through /api/aa/sponsor + /api/aa/send. ONE Magic signature, gas
    // sponsored by Mako. Wallet-connected users without a Magic session
    // fall through to the existing wagmi 2-tx path below.
    // Plan step 18 narrowing: only Magic-shape users have a Safe +
    // magicEoa. Wallet-session users fall through to the wagmi path
    // below — their connected wallet IS their signer.
    if (user?.authType === 'magic' && !userLoading) {
      try {
        const amount = parseUsdc(amountUsdc);
        const safeAddress = user.safeAddress as `0x${string}`;
        const magicEoa = user.magicEoa as `0x${string}`;

        // Read current allowance(safe, MAKO) so runPlaceBet can decide
        // single-call vs batched. Idempotent: a stale-low read just
        // costs a redundant approve(MaxUint256) on chain (Pimlico pays).
        const currentAllowance = (await publicClient.readContract({
          ...usdcContract,
          functionName: 'allowance',
          args: [safeAddress, MAKO_ADDRESS],
        })) as bigint;

        // Magic flow doesn't surface a separate approve step to the UI —
        // even when the batched [approve, placeBet] op runs, the user
        // sees a single Magic prompt. Phase goes preparing → betting →
        // awaitingBet → success/error, skipping approving/awaitingApprove.
        setPhase('betting');
        const outcome: RunOutcome = await runPlaceBet({
          chainId: MONAD_TESTNET_ID,
          marketId: id,
          isYes,
          amountUsdc: amount,
          usdcAddress: USDC_ADDRESS,
          makoAddress: MAKO_ADDRESS,
          magicEoa,
          currentAllowance,
        });

        setPhase('awaitingBet');
        switch (outcome.kind) {
          case 'sent':
            setBetHash(outcome.txHash);
            setPhase('success');
            return;
          case 'reverted':
            setBetHash(outcome.txHash);
            setPhase('error');
            setError(
              new Error(
                'Bet reverted on chain. Your USDC is safe; please retry. (You may want to refresh first.)',
              ),
            );
            return;
          case 'submitted':
            // Bundler accepted; receipt poll didn't confirm in 90s. The
            // cron resolver settles within ~5min via on-chain truth.
            // Non-blocking info state — `submitted` is rendered with
            // visible explanatory copy, NOT as a busy button label that
            // hides the message. Bet hash isn't available yet (no on-
            // chain receipt), so we can't surface a tx link; userOpHash
            // gives the operator something to grep.
            setPhase('submitted');
            return;
          case 'failed_pre_submit':
            setPhase('error');
            setError(
              new Error(`Bundler rejected the bet: ${outcome.failureReason}`),
            );
            return;
          case 'in_progress':
            setPhase('error');
            setError(
              new Error(
                `Already sending — please wait ${outcome.retryAfterSeconds}s and try again.`,
              ),
            );
            return;
          case 'expired':
            setPhase('error');
            setError(
              new Error('Confirmation took too long; please retry.'),
            );
            return;
          case 'manual_review':
            setPhase('error');
            setError(
              new Error(
                'This bet needs operator review. We will follow up; no action needed.',
              ),
            );
            return;
          case 'sponsor_failed':
            setPhase('error');
            setError(
              new Error(
                outcome.error === 'CAP_EXCEEDED'
                  ? `You've reached today's sponsored-op limit (${SPONSOR_CAP_PER_USER_PER_DAY}/day). Try again tomorrow, or use a connected wallet.`
                  : outcome.error === 'SPONSOR_UNAVAILABLE'
                    ? 'Sponsorship temporarily unavailable. Try again shortly, or use a connected wallet.'
                    : outcome.error === 'NOT_ALLOWED'
                      ? `Bet rejected by sponsorship policy${outcome.reason ? ` (${outcome.reason})` : ''}.`
                      : `Sponsorship failed: ${outcome.detail ?? outcome.error}`,
              ),
            );
            return;
          case 'send_failed':
            setPhase('error');
            setError(
              new Error(
                outcome.error === 'SIG_VALIDATION'
                  ? 'Could not verify your signature. Please retry.'
                  : `Send failed: ${outcome.detail ?? outcome.error}`,
              ),
            );
            return;
        }
      } catch (e) {
        setPhase('error');
        setError(e instanceof Error ? e : new Error(String(e)));
        return;
      } finally {
        inFlightRef.current = false;
      }
    }

    // ── Wallet-connected branch (existing wagmi flow) ──────────────────
    if (!address) {
      const e = new Error('Connect a wallet or sign in with email to place a bet.');
      setPhase('error');
      setError(e);
      inFlightRef.current = false;
      return;
    }

    try {
      await ensureChain();
      const amount = parseUsdc(amountUsdc);

      // Allowance gate — infinite approval if currently below required amount.
      const currentAllowance = (await publicClient.readContract({
        ...usdcContract,
        functionName: 'allowance',
        args: [address, MAKO_ADDRESS],
      })) as bigint;

      if (currentAllowance < amount) {
        setPhase('approving');
        const aHash = await writeContractAsync({
          ...usdcContract,
          functionName: 'approve',
          args: [MAKO_ADDRESS, maxUint256],
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

      // Pre-flight simulate — surface v4 anti-abuse reverts with decoded names
      // before the user signs the bet tx. If approve was just submitted, the
      // user's USDC allowance is now MaxUint256, so retries don't need another
      // approve regardless of how this branch resolves.
      try {
        await publicClient.simulateContract({
          ...makoContract,
          functionName: 'placeBet',
          args: [id, isYes, amount],
          account: address,
        });
      } catch (simErr) {
        setPhase('error');
        setError(decodeContractError(simErr));
        return;
      }

      setPhase('betting');
      const bHash = await writeContractAsync({
        ...makoContract,
        functionName: 'placeBet',
        args: [id, isYes, amount],
      });
      setBetHash(bHash);
      setPhase('awaitingBet');

      const betReceipt = await publicClient.waitForTransactionReceipt({
        hash: bHash,
      });
      if (betReceipt.status !== 'success') {
        // Mined-receipt failures don't carry decoded revert data — recovering
        // it requires an eth_call replay we don't implement in 1C. Generic
        // copy + the reassurance that the approve isn't lost.
        setPhase('error');
        setError(
          new Error(
            'Bet failed after confirmation, likely because market state changed. USDC approval is preserved — you can retry without re-approving.',
          ),
        );
        return;
      }
      setPhase('success');
    } catch (err) {
      setPhase('error');
      setError(decodeContractError(err));
    } finally {
      inFlightRef.current = false;
    }
  }, [publicClient, address, ensureChain, writeContractAsync, user, userLoading]);

  const flow: 'magic' | 'wallet' | 'loading' = userLoading
    ? 'loading'
    : user?.authType === 'magic'
      ? 'magic'
      : 'wallet';

  return {
    placeBet,
    phase,
    approveHash,
    betHash,
    error,
    reset,
    /// Discriminator the UI uses to render auth-aware copy. `magic` =
    /// Phase 1D AA flow (one Magic signature, gas sponsored). `wallet` =
    /// existing wagmi 2-tx flow. `loading` = the `useUser` query is
    /// still in flight; treat as busy.
    flow,
    /// The address whose USDC balance + allowance matter for THIS flow.
    /// For Magic users that's the Safe (since the placeBet pulls from
    /// the Safe via transferFrom); for wallet users it's the connected
    /// wallet address. BetSheet uses this for its balance pill,
    /// allowance check, and first-approval banner condition so a Magic
    /// user with an underfunded connected wallet doesn't see
    /// "INSUFFICIENT USDC" against the wrong account (round-1 MAJOR 1
    /// fix from Group 5 review).
    bettingAccount: (flow === 'magic' && user?.authType === 'magic'
      ? (user.safeAddress as `0x${string}`)
      : address) as `0x${string}` | undefined,
  };
}

// ---------------------------------------------------------------
// Writes — claim, create, resolve, claim creator fee
// ---------------------------------------------------------------

/**
 * Claim winnings (or refund) for a resolved market.
 *
 * claim-magic-parity: dual-path mirror of `usePlaceBet` / `useCreateMarket`.
 * Magic-authed users go through /api/aa/sponsor + Magic personal_sign +
 * /api/aa/send (kind='claim'); wallet-connected users use the existing
 * wagmi `writeContractAsync` flow.
 *
 * Without this dual-path, Magic users either couldn't see the claim
 * button (the visibility bug fixed in ClaimButton + MarketClaimAction) or,
 * if visible, the click would fail because `writeContractAsync` has no
 * signer for an embedded Safe.
 */
export type ClaimPhase =
  | 'idle'
  | 'preparing'
  | 'awaitingSign'   // Magic: prompting user for personal_sign
  | 'awaitingClaim'  // Magic: bundler accepted, polling receipt
  | 'awaitingWallet' // wallet: writeContract pending
  | 'success'
  | 'submitted'      // Magic: bundler accepted, receipt poll timed out (cron settles)
  | 'error';

export function useClaim() {
  const { user, isLoading: userLoading } = useUser();
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const [phase, setPhase] = useState<ClaimPhase>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [hash, setHash] = useState<`0x${string}` | undefined>();
  // Synchronous double-submit guard (mirrors usePlaceBet's ref pattern).
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    setPhase('idle');
    setError(null);
    setHash(undefined);
  }, []);

  const claim = useCallback(async (id: bigint) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setHash(undefined);
    setPhase('preparing');

    try {
      // Codex r1 MAJ-3: while /api/user/me is in flight, `user` is
      // null. Falling through to the wallet branch would let a Magic
      // user accidentally route through a stale wagmi connection
      // (the wrong identity). Surface a clean retry error instead.
      if (userLoading) {
        setPhase('error');
        setError(new Error('Still loading your account. Please retry in a moment.'));
        return;
      }

      // ── Magic-authed branch ────────────────────────────────────────
      if (user?.authType === 'magic') {
        const magicEoa = user.magicEoa as `0x${string}`;
        setPhase('awaitingSign');
        const outcome: RunOutcome = await runClaim({
          chainId: MONAD_TESTNET_ID,
          makoAddress: MAKO_ADDRESS,
          marketId: id,
          magicEoa,
        });
        setPhase('awaitingClaim');
        switch (outcome.kind) {
          case 'sent':
            setHash(outcome.txHash);
            setPhase('success');
            return;
          case 'reverted':
            setHash(outcome.txHash);
            setPhase('error');
            setError(
              new Error(
                'Claim reverted on chain. Try refreshing; your position is safe.',
              ),
            );
            return;
          case 'submitted':
            // Bundler accepted; receipt poll didn't confirm in 90s.
            // Cron settles within ~5 min from on-chain truth.
            setPhase('submitted');
            return;
          case 'failed_pre_submit':
            setPhase('error');
            setError(
              new Error(`Bundler rejected the claim: ${outcome.failureReason}`),
            );
            return;
          case 'in_progress':
            setPhase('error');
            setError(
              new Error(
                `Already sending: please wait ${outcome.retryAfterSeconds}s and try again.`,
              ),
            );
            return;
          case 'expired':
            setPhase('error');
            setError(new Error('Confirmation took too long; please retry.'));
            return;
          case 'manual_review':
            setPhase('error');
            setError(
              new Error(
                'This claim needs operator review. We will follow up; no action needed.',
              ),
            );
            return;
          case 'sponsor_failed':
            setPhase('error');
            setError(
              new Error(
                outcome.error === 'CAP_EXCEEDED'
                  ? `You've reached today's sponsored-op limit (${SPONSOR_CAP_PER_USER_PER_DAY}/day). Try again tomorrow, or use a connected wallet.`
                  : outcome.error === 'SPONSOR_UNAVAILABLE'
                    ? 'Sponsorship temporarily unavailable. Try again shortly, or use a connected wallet.'
                    : outcome.error === 'NOT_ALLOWED'
                      ? `Claim rejected by sponsorship policy${outcome.reason ? ` (${outcome.reason})` : ''}.`
                      : `Sponsorship failed: ${outcome.detail ?? outcome.error}`,
              ),
            );
            return;
          case 'send_failed':
            setPhase('error');
            setError(
              new Error(
                outcome.error === 'SIG_VALIDATION'
                  ? 'Could not verify your signature. Please retry.'
                  : `Send failed: ${outcome.detail ?? outcome.error}`,
              ),
            );
            return;
        }
        return;
      }

      // ── Wallet-connected branch (existing wagmi flow) ──────────────
      await ensureChain();
      setPhase('awaitingWallet');
      const txHash = await writeContractAsync({
        ...makoContract,
        functionName: 'claim',
        args: [id],
      });
      setHash(txHash);
      setPhase('success');
    } catch (e) {
      setPhase('error');
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      inFlightRef.current = false;
    }
  }, [user, userLoading, writeContractAsync, ensureChain]);

  const isPending =
    phase === 'preparing' ||
    phase === 'awaitingSign' ||
    phase === 'awaitingClaim' ||
    phase === 'awaitingWallet';

  return { claim, hash, isPending, error, reset, phase };
}

/**
 * Create a new market. v4 takes a 5-arg signature with two distinct
 * timestamps:
 *   - `bettingCloseTime` — when placeBet stops being legal
 *   - `closeTime`         — when resolveMarket becomes legal
 *
 * Per-type defaults live at the call site (see `/create/page.tsx` and
 * the seed scripts) driven by `src/lib/market-timing.ts`. **Do not
 * default `bettingCloseTime` to `closeTime` here** — that's the v3
 * model and would let the resolver fire before sports events end.
 *
 * Phase 1H: branches on `useUser()`. Magic users → AA path via
 * `runCreateMarket` (one Magic signature, gas sponsored by Pimlico).
 * Wallet users → unchanged wagmi 2-tx flow. The hook returns a
 * `CreateMarketResult` discriminated union so the page can branch
 * unambiguously on every flow outcome (created / wallet_submitted /
 * submitted / decode_pending / decode_failed / reverted / error).
 *
 * Wallet branch ALWAYS returns `{ kind: 'wallet_submitted' }`; the
 * page reads `hook.hash` and uses `useWaitForTransactionReceipt` plus
 * `decodeMarketCreatedId` to drive its own redirect lifecycle.
 * Magic branch resolves with `kind: 'created'` (decoded newId) on
 * the happy path or one of the other variants on partial outcomes.
 */
export type CreateMarketResult =
  /// Magic happy path: bundler accepted, receipt landed, MarketCreated decoded.
  | { kind: 'created'; newId: bigint; txHash: Hex; userOpHash: Hex }
  /// Wallet path: writeContractAsync returned. Page drives the rest via
  /// useWaitForTransactionReceipt({ hash: hook.hash }).
  | { kind: 'wallet_submitted' }
  /// Magic: bundler accepted but server-side receipt poll didn't confirm in 90s.
  /// No txHash yet; cron will catch up. UI shows "we'll catch up" copy.
  | { kind: 'submitted'; userOpHash: Hex }
  /// Magic: tx landed; client-side receipt fetch timed out (RPC visibility lag).
  /// Distinct from 'submitted' — there IS a txHash; user can copy/paste it.
  | { kind: 'decode_pending'; txHash: Hex; userOpHash: Hex }
  /// Magic: receipt landed; decodeMarketCreatedId returned null. Code bug.
  | { kind: 'decode_failed'; txHash: Hex; userOpHash: Hex }
  /// Magic: tx landed but reverted on chain.
  | { kind: 'reverted'; txHash: Hex; userOpHash: Hex; reason: string }
  /// Magic: sponsor / send / pre-submit / network rejection.
  | { kind: 'error'; message: string; reason?: string };

type CreateMarketArgs = {
  mType: MarketType;
  oracleRef: `0x${string}`;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
};

/// Pinned to Monad testnet so the receipt decode targets the correct
/// chain even if the user's wallet is on a different chain (Magic
/// users may have no wallet at all).
const MAGIC_RECEIPT_TIMEOUT_MS = 30_000;

export function useCreateMarket() {
  const { user, isLoading: userLoading } = useUser();
  const {
    writeContractAsync,
    data: hash,
    isPending: walletIsPending,
    error: walletError,
    reset: walletReset,
  } = useWriteContract();
  const ensureChain = useEnsureMonadChain();
  /// Pinned public client — Magic users may have no wallet, and even
  /// wallet users may be on a different chain at the moment we fetch
  /// the receipt. wagmi's chainId arg returns the Monad-bound client
  /// regardless of the currently-selected chain in the UI.
  const publicClient = usePublicClient({ chainId: monadTestnet.id });

  const [magicPhase, setMagicPhase] = useState<
    'idle' | 'creating' | 'awaiting' | 'success' | 'error'
  >('idle');
  const [magicError, setMagicError] = useState<Error | null>(null);
  const [magicTxHash, setMagicTxHash] = useState<Hex | undefined>();
  const [magicUserOpHash, setMagicUserOpHash] = useState<Hex | undefined>();
  /// Synchronous double-click guard — same pattern as usePlaceBet's
  /// inFlightRef. Prevents two concurrent Magic prompts when a user
  /// double-clicks the submit button before any state setter renders.
  const inFlightRef = useRef(false);

  const flow: 'magic' | 'wallet' | 'loading' = userLoading
    ? 'loading'
    : user?.authType === 'magic'
      ? 'magic'
      : 'wallet';

  const reset = useCallback(() => {
    walletReset();
    setMagicPhase('idle');
    setMagicError(null);
    setMagicTxHash(undefined);
    setMagicUserOpHash(undefined);
    inFlightRef.current = false;
  }, [walletReset]);

  const create = useCallback(
    async (args: CreateMarketArgs): Promise<CreateMarketResult> => {
      if (args.bettingCloseTime > args.closeTime) {
        const err = new Error(
          'bettingCloseTime must be on or before closeTime.',
        );
        setMagicError(err);
        setMagicPhase('error');
        return { kind: 'error', message: err.message };
      }

      if (inFlightRef.current) {
        return {
          kind: 'error',
          message: 'A market creation is already in progress.',
        };
      }
      // Round-8 MAJOR 1: while the user query is loading we cannot
      // know whether to take the Magic or wallet branch. Falling
      // through to wallet would recreate the original "Connector
      // not connected" failure for a Magic-authed user clicking
      // during the cold-load window. Refuse the call and let the
      // page disable the button (flow === 'loading' is included in
      // isBusy below).
      if (userLoading) {
        return {
          kind: 'error',
          message: 'Still checking your sign-in — please retry in a second.',
          reason: 'auth_loading',
        };
      }
      inFlightRef.current = true;

      // ── Magic-authed branch (Phase 1H) ─────────────────────────────
      // Gate on the discriminant, NOT just truthy `user`. Wallet-authed
      // users have a truthy `user` object with `authType === 'wallet'`
      // (Phase 1F+); they must fall through to the wagmi branch below.
      // The original `if (user)` guard sent every signed-in user — Magic
      // and wallet — into this branch, then threw "magic-flow guard fell
      // through for non-magic user" on the magicEoa fallthrough. The
      // wallet user never got to the wagmi `writeContractAsync` path.
      if (user?.authType === 'magic') {
        try {
          setMagicError(null);
          setMagicTxHash(undefined);
          setMagicUserOpHash(undefined);
          setMagicPhase('creating');

          const outcome: RunOutcome = await runCreateMarket({
            chainId: MONAD_TESTNET_ID,
            makoAddress: MAKO_ADDRESS,
            mType: args.mType,
            oracleRef: args.oracleRef,
            bettingCloseTime: args.bettingCloseTime,
            closeTime: args.closeTime,
            question: args.question,
            magicEoa: user.magicEoa as `0x${string}`,
          });

          setMagicPhase('awaiting');

          switch (outcome.kind) {
            case 'sent': {
              setMagicTxHash(outcome.txHash);
              setMagicUserOpHash(outcome.userOpHash);
              if (!publicClient) {
                setMagicPhase('error');
                setMagicError(new Error('RPC client not ready — please retry.'));
                return {
                  kind: 'decode_pending',
                  txHash: outcome.txHash,
                  userOpHash: outcome.userOpHash,
                };
              }
              // Bounded wait for the receipt — public RPC visibility
              // can lag Pimlico's eth_getUserOperationReceipt by 1-3s.
              try {
                const receipt = await publicClient.waitForTransactionReceipt({
                  hash: outcome.txHash,
                  timeout: MAGIC_RECEIPT_TIMEOUT_MS,
                  pollingInterval: 1500,
                });
                const newId = decodeMarketCreatedId(
                  receipt as unknown as TransactionReceipt,
                );
                if (newId === null) {
                  setMagicPhase('error');
                  setMagicError(
                    new Error(
                      'Transaction landed, but the new market id could not be decoded. Refresh /me to find it.',
                    ),
                  );
                  return {
                    kind: 'decode_failed',
                    txHash: outcome.txHash,
                    userOpHash: outcome.userOpHash,
                  };
                }
                setMagicPhase('success');
                return {
                  kind: 'created',
                  newId,
                  txHash: outcome.txHash,
                  userOpHash: outcome.userOpHash,
                };
              } catch {
                // Timeout — receipt didn't show up in 30s. Cron resolver
                // settles within ~5min via on-chain truth.
                setMagicPhase('error');
                setMagicError(
                  new Error(
                    'Transaction submitted, but the receipt is taking longer than expected. Refresh /me in a moment.',
                  ),
                );
                return {
                  kind: 'decode_pending',
                  txHash: outcome.txHash,
                  userOpHash: outcome.userOpHash,
                };
              }
            }
            case 'reverted':
              setMagicTxHash(outcome.txHash);
              setMagicUserOpHash(outcome.userOpHash);
              setMagicPhase('error');
              setMagicError(
                new Error(
                  `Market creation reverted on chain: ${outcome.failureReason ?? 'unknown reason'}`,
                ),
              );
              return {
                kind: 'reverted',
                txHash: outcome.txHash,
                userOpHash: outcome.userOpHash,
                reason: outcome.failureReason ?? 'on-chain revert',
              };
            case 'submitted':
              // Bundler accepted; server-side receipt poll didn't confirm
              // in 90s. No client-side polling — cron resolver settles
              // within ~5min and the user has to refresh /me to see the
              // market. Round-8 MINOR 3 + round-9 MINOR 1: copy
              // matches the page banner; do not promise a redirect.
              setMagicUserOpHash(outcome.userOpHash);
              setMagicPhase('error');
              setMagicError(
                new Error(
                  'Market submitted. Refresh /me in a few minutes to see it.',
                ),
              );
              return { kind: 'submitted', userOpHash: outcome.userOpHash };
            case 'failed_pre_submit':
              setMagicPhase('error');
              setMagicError(
                new Error(`Bundler rejected: ${outcome.failureReason}`),
              );
              return {
                kind: 'error',
                message: `Bundler rejected: ${outcome.failureReason}`,
                reason: 'failed_pre_submit',
              };
            case 'in_progress':
              setMagicPhase('error');
              setMagicError(
                new Error(
                  `Already sending — please wait ${outcome.retryAfterSeconds}s and try again.`,
                ),
              );
              return {
                kind: 'error',
                message: 'Already sending — please wait and try again.',
                reason: 'in_progress',
              };
            case 'expired':
              setMagicPhase('error');
              setMagicError(
                new Error('Confirmation took too long; please retry.'),
              );
              return {
                kind: 'error',
                message: 'Confirmation took too long; please retry.',
                reason: 'expired',
              };
            case 'manual_review':
              setMagicPhase('error');
              setMagicError(
                new Error(
                  'This market needs operator review. We will follow up; no action needed.',
                ),
              );
              return {
                kind: 'error',
                message:
                  'This market needs operator review. We will follow up; no action needed.',
                reason: 'manual_review',
              };
            case 'sponsor_failed': {
              const message =
                outcome.error === 'CAP_EXCEEDED'
                  ? `You've reached today's sponsored-op limit (${SPONSOR_CAP_PER_USER_PER_DAY}/day). Try again tomorrow, or use a connected wallet.`
                  : outcome.error === 'SPONSOR_UNAVAILABLE'
                    ? 'Sponsorship temporarily unavailable. Try again shortly, or use a connected wallet.'
                    : outcome.error === 'NOT_ALLOWED'
                      ? `Market creation rejected by sponsorship policy${outcome.reason ? ` (${outcome.reason})` : ''}.`
                      : `Sponsorship failed: ${outcome.detail ?? outcome.error}`;
              setMagicPhase('error');
              setMagicError(new Error(message));
              return { kind: 'error', message, reason: outcome.reason };
            }
            case 'send_failed': {
              const message =
                outcome.error === 'SIG_VALIDATION'
                  ? 'Could not verify your signature. Please retry.'
                  : `Send failed: ${outcome.detail ?? outcome.error}`;
              setMagicPhase('error');
              setMagicError(new Error(message));
              return { kind: 'error', message, reason: outcome.error };
            }
          }
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          setMagicPhase('error');
          setMagicError(err);
          return { kind: 'error', message: err.message };
        } finally {
          inFlightRef.current = false;
        }
      }

      // ── Wallet-connected branch (existing wagmi flow) ──────────────
      try {
        await ensureChain();
        await writeContractAsync({
          ...makoContract,
          functionName: 'createMarket',
          args: [
            args.mType,
            args.oracleRef,
            args.bettingCloseTime,
            args.closeTime,
            args.question,
          ],
        });
        return { kind: 'wallet_submitted' };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return { kind: 'error', message: err.message };
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      user,
      userLoading,
      publicClient,
      ensureChain,
      writeContractAsync,
    ],
  );

  // Unified pending state: wagmi's wallet-flow isPending OR our local
  // Magic-flow phase being non-idle non-terminal OR the auth query
  // still loading (round-8 MAJOR 1 — gates the submit button so a
  // Magic-authed user can't click during the cold-load window and
  // fall through to the wallet branch).
  const isPending =
    walletIsPending ||
    magicPhase === 'creating' ||
    magicPhase === 'awaiting' ||
    flow === 'loading';

  // Unified error: prefer Magic-flow error when present; fall back to
  // wagmi's error so existing /create copy still surfaces wallet-side
  // failures unchanged.
  const error = magicError ?? (walletError as Error | null) ?? null;

  return {
    create,
    /// Wallet flow tx hash. `undefined` for Magic users (the Magic
    /// txHash arrives in the resolved CreateMarketResult).
    hash,
    /// Magic flow user-op hash. `undefined` for wallet users.
    userOpHash: magicUserOpHash,
    /// Magic flow tx hash, when available. Distinct from `hash` so
    /// callers don't conflate the two flows.
    magicTxHash,
    isPending,
    error,
    reset,
    flow,
  };
}

/**
 * Admin: resolve a closed market with an outcome (YES / NO / REFUND).
 * Gated on-chain by the `onlyResolver` modifier. UI-level admin gate
 * is cosmetic and lives in `src/lib/admin.ts`.
 */
export function useResolveMarket() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const resolve = async ({ id, outcome }: { id: bigint; outcome: Outcome }) => {
    await ensureChain();
    return writeContractAsync({
      ...makoContract,
      functionName: 'resolveMarket',
      args: [id, outcome],
    });
  };

  return { resolve, hash, isPending, error, reset };
}

/**
 * Claim the creator fee on a resolved non-refund market.
 * Only the market's original creator can call this. v4 emits
 * `CreatorFeeForfeited` and transfers 0 USDC if the final pool ratio
 * sat below the forfeit threshold.
 */
export function useClaimCreatorFee() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const claimFee = async (id: bigint) => {
    await ensureChain();
    return writeContractAsync({
      ...makoContract,
      functionName: 'claimCreatorFee',
      args: [id],
    });
  };

  return { claimFee, hash, isPending, error, reset };
}
