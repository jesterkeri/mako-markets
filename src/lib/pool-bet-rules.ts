// Why a bet can't be placed, checked in the order MakoMarketsV4.placeBet checks it, with the words the pool page
// (9a) shows. A snapshot for the button: the contract re-checks every rule when the bet lands.

import type { MarketWithId } from './contract';
import { usdc2 } from './pool-list';

/// MakoMarketsV4 constants.
export const MIN_BET = 100_000n;
export const MIN_SECONDS_BETWEEN_BETS = 30;

/// The contract's per-wallet limits, read live (the owner can change the caps).
export type BetLimits = {
  blocked: boolean;
  /// lastBetTime(id, wallet), seconds; 0 when the wallet has never bet on this pool.
  lastBetTime: number;
  maxPerWallet: bigint;
  maxShareBps: number;
  shareCapMinPool: bigint;
};

export type Stake = { yes: bigint; no: bigint };

/// "5", "5.5", "0.10" -> base units; null for anything else (empty, negative, more than 6 decimals, not a number).
export function parseAmount(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

export function betBlocker(args: {
  m: MarketWithId;
  nowSec: number;
  amount: bigint;
  /// null while the balance is still loading.
  balance: bigint | null;
  mine: Stake;
  /// null while the limits are still loading: the per-wallet checks wait for them.
  limits: BetLimits | null;
}): string | null {
  const { m, nowSec, amount, balance, mine, limits } = args;
  if (m.resolved || nowSec >= Number(m.bettingCloseTime)) return 'Betting has closed on this pool.';
  if (amount < MIN_BET) return 'The minimum bet is 0.10 USDC.';
  if (limits) {
    if (limits.blocked) return 'This wallet is blocked from betting on Mako Market pools.';
    const wait = limits.lastBetTime === 0 ? 0 : limits.lastBetTime + MIN_SECONDS_BETWEEN_BETS - nowSec;
    if (wait > 0) return `One bet per pool every 30 seconds. Try again in ${wait}s.`;
    const walletAfter = mine.yes + mine.no + amount;
    if (walletAfter > limits.maxPerWallet) {
      return `One wallet can put at most ${usdc2(limits.maxPerWallet)} USDC into a pool. You have ${usdc2(mine.yes + mine.no)} in.`;
    }
    const poolAfter = m.totalYes + m.totalNo + amount;
    if (poolAfter >= limits.shareCapMinPool && walletAfter * 10_000n > poolAfter * BigInt(limits.maxShareBps)) {
      return `Once a pool reaches ${usdc2(limits.shareCapMinPool)} USDC, one wallet can hold at most ${limits.maxShareBps / 100}% of it. Try a smaller amount.`;
    }
  }
  if (balance !== null && amount > balance) return `Not enough USDC. Your balance is ${usdc2(balance)}.`;
  return null;
}
