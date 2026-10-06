// The running totals both contracts' handlers share: the one GlobalStats row, the UTC day, the wallet created on first
// sight, and a wallet's activity on a day. Pools and rounds move the same wallet, day and global rows, so a person
// counts once in the public totals whichever product they used.

import type { DailyStats, EvmOnEventContext, GlobalStats, Wallet } from 'envio';

export type HandlerContext = EvmOnEventContext;

import { isInternal } from '../internal-wallets';
import { dayOf, walletDayId } from '../totals';

export const GLOBAL_ID = 'global';

export async function loadGlobal(context: HandlerContext): Promise<GlobalStats> {
  return (
    (await context.GlobalStats.get(GLOBAL_ID)) ?? {
      id: GLOBAL_ID,
      wallets: 0,
      bettors: 0,
      bets: 0,
      volume: 0n,
      pools: 0,
      communityPools: 0,
      poolsSettled: 0,
      poolsRefunded: 0,
      communityPoolsSettled: 0,
      communityPoolsRefunded: 0,
      claims: 0,
      claimed: 0n,
      creatorFeesPaid: 0n,
      internalWallets: 0,
      rounds: 0,
      roundsUp: 0,
      roundsDown: 0,
      roundsRefunded: 0,
      roundsTied: 0,
      roundsOneSided: 0,
      roundsNoPrice: 0,
      roundEntrants: 0,
      roundEntries: 0,
      roundVolume: 0n,
      roundClaims: 0,
      roundClaimed: 0n,
      updatedAt: 0,
      updatedBlock: 0,
    }
  );
}

export async function loadDay(context: HandlerContext, timestamp: number, global: GlobalStats): Promise<DailyStats> {
  const day = dayOf(timestamp);
  return (
    (await context.DailyStats.get(day.id)) ?? {
      id: day.id,
      dayStart: day.start,
      newWallets: 0,
      activeWallets: 0,
      bets: 0,
      volume: 0n,
      poolsCreated: 0,
      claims: 0,
      claimed: 0n,
      cumulativeWallets: global.wallets,
      roundEntries: 0,
      roundVolume: 0n,
    }
  );
}

/// The wallet, created on first sight. A new public wallet counts once, in the global total and on its first day.
export async function loadWallet(
  context: HandlerContext,
  rawAddress: string,
  timestamp: number,
  global: GlobalStats,
  day: DailyStats,
): Promise<{ wallet: Wallet; global: GlobalStats; day: DailyStats }> {
  const id = rawAddress.toLowerCase();
  const existing = await context.Wallet.get(id);
  if (existing) return { wallet: existing, global, day };
  const internal = isInternal(id);
  const wallet: Wallet = {
    id,
    internal,
    firstSeenAt: timestamp,
    lastActiveAt: timestamp,
    betCount: 0,
    poolsBet: 0,
    poolsCreated: 0,
    staked: 0n,
    claimed: 0n,
    creatorFees: 0n,
    roundEntryCount: 0,
    roundsEntered: 0,
    roundStaked: 0n,
    roundClaimed: 0n,
    roundCreatorFees: 0n,
    net: 0n,
  };
  if (internal) return { wallet, global: { ...global, internalWallets: global.internalWallets + 1 }, day };
  const wallets = global.wallets + 1;
  return { wallet, global: { ...global, wallets }, day: { ...day, newWallets: day.newWallets + 1, cumulativeWallets: wallets } };
}

/// Counts a public wallet as active on the day once.
export async function markActive(context: HandlerContext, wallet: Wallet, day: DailyStats): Promise<DailyStats> {
  if (wallet.internal) return day;
  const id = walletDayId(wallet.id, day.id);
  if (await context.WalletDay.get(id)) return day;
  context.WalletDay.set({ id });
  return { ...day, activeWallets: day.activeWallets + 1 };
}

export function stamp(global: GlobalStats, timestamp: number, block: number): GlobalStats {
  return { ...global, updatedAt: timestamp, updatedBlock: block };
}
