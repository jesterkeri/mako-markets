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
} from 'viem';
import {
  MAKO_ADDRESS,
  makoContract,
  type MarketWithId,
  type Market,
  MarketType,
  Outcome,
} from './contract';
import { usdcContract } from './usdc';
import { parseUsdc } from './usdc';
import { monadTestnet } from './chain';

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
function useEnsureMonadChain() {
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
  | 'error';

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
 * Place a bet on a v4 market.
 *
 * **External-wallet flow only.** Embedded Magic + ERC-4337 batched
 * single-signature flow lands in Phase 1D as a sibling hook.
 *
 * Steps:
 *   1. ensureChain — switch wallet to Monad testnet if needed
 *   2. allowance check — approve `MaxUint256` if `allowance < amount`
 *      (infinite approval; standard pattern, see header note in BetSheet)
 *   3. simulateContract pre-flight — surfaces v4 anti-abuse reverts
 *      (WalletIsBlocked, BetTooSoon, WalletCapExceeded,
 *      WalletShareCapExceeded, BettingClosed) with decoded error names
 *      BEFORE the user signs the bet tx
 *   4. writeContract placeBet — submit the bet
 *   5. waitForTransactionReceipt — surface mined-receipt failures
 *
 * Phase state machine drives BetSheet button copy without the hook
 * having to know about the UI.
 */
export function usePlaceBet() {
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
    if (!address) {
      const e = new Error('Connect a wallet to place a bet.');
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
  }, [publicClient, address, ensureChain, writeContractAsync]);

  return {
    placeBet,
    phase,
    approveHash,
    betHash,
    error,
    reset,
  };
}

// ---------------------------------------------------------------
// Writes — claim, create, resolve, claim creator fee
// ---------------------------------------------------------------

/**
 * Claim winnings (or refund) for a resolved market.
 */
export function useClaim() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const claim = async (id: bigint) => {
    await ensureChain();
    return writeContractAsync({
      ...makoContract,
      functionName: 'claim',
      args: [id],
    });
  };

  return { claim, hash, isPending, error, reset };
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
 * The hook guards `bettingCloseTime <= closeTime` defensively so a
 * caller bug doesn't burn gas on a known-revert tx.
 *
 * The caller is responsible for parsing the `MarketCreated` event from
 * the tx receipt to extract the new id. Note that v4's MarketCreated
 * event emits `(id, creator, mType, oracleRef, closeTime, question)` —
 * `bettingCloseTime` is NOT in the event; read it via `getMarket(id)`
 * if needed.
 */
export function useCreateMarket() {
  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const ensureChain = useEnsureMonadChain();

  const create = async ({
    mType,
    oracleRef,
    bettingCloseTime,
    closeTime,
    question,
  }: {
    mType: MarketType;
    oracleRef: `0x${string}`;
    bettingCloseTime: bigint;
    closeTime: bigint;
    question: string;
  }) => {
    if (bettingCloseTime > closeTime) {
      throw new Error('bettingCloseTime must be on or before closeTime.');
    }
    await ensureChain();
    return writeContractAsync({
      ...makoContract,
      functionName: 'createMarket',
      args: [mType, oracleRef, bettingCloseTime, closeTime, question],
    });
  };

  return { create, hash, isPending, error, reset };
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
