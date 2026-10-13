// Rounds in Me (Joshua 2026-10-13: "users can only claim rounds earnings from the rounds tab ... let it appear in me
// too"): the account's round positions as Me's totals and claims, beside its pools. Pure; read by use-me-rounds.ts.

import { positionOf, RoundStatus, type Position, type Round, type Stake } from './rounds-model';

export type MeRound = {
  round: Round;
  /// `none` for a round the account hosted without a stake (it is listed only for its creator fee).
  position: Position;
  /// The host's creator fee `claim` also pays: the account created this settled round and has not claimed the fee.
  creatorFee: bigint;
  /// What `claim(roundId)` pays now, or null: a win not yet claimed, or a refund marked on chain and not yet claimed,
  /// plus `creatorFee` (MakoRoundsV1.claim, adversary on 926d326). A refund that qualifies but is not marked yet is not
  /// claimable from Me (the round page marks it first).
  claim: bigint | null;
};

export type RoundStakeRead = { stake: Stake; claimed: boolean; creatorFeeClaimed: boolean };

/// Every round this account has a stake in, or hosted with a creator fee still to claim, newest first.
export function meRoundPositions(rounds: readonly Round[], stakes: ReadonlyMap<string, RoundStakeRead>, account: string, nowS: number): MeRound[] {
  const me = account.toLowerCase();
  const out: MeRound[] = [];
  for (const round of rounds) {
    const s = stakes.get(round.id.toString());
    if (!s) continue;
    const creatorFee =
      round.creator.toLowerCase() === me && round.status === RoundStatus.Settled && round.creatorFee > 0n && !s.creatorFeeClaimed ? round.creatorFee : 0n;
    const position = s.stake.side && s.stake.amount > 0n ? positionOf(round, s.stake, s.claimed, nowS) : ({ kind: 'none' } as const);
    if (position.kind === 'none' && creatorFee === 0n) continue;
    const own = claimOf(position);
    const total = (own ?? 0n) + creatorFee;
    out.push({ round, position, creatorFee, claim: total > 0n ? total : null });
  }
  return out.sort((a, b) => (a.round.id === b.round.id ? 0 : a.round.id > b.round.id ? -1 : 1));
}

function claimOf(p: Position): bigint | null {
  if (p.kind === 'won' && !p.claimed && p.payout > 0n) return p.payout;
  if (p.kind === 'refund' && p.marked && !p.claimed) return p.amount;
  return null;
}

/// Whether this account already claimed a creator fee from a round it hosted. Such a round can drop out of
/// meRoundPositions (nothing left to claim), so Me's "Everything claimed" needs this too (adversary r2 on de5ef9e).
export function hostFeeClaimedBefore(rounds: readonly Round[], stakes: ReadonlyMap<string, RoundStakeRead>, account: string): boolean {
  const me = account.toLowerCase();
  return rounds.some(
    (r) => r.creator.toLowerCase() === me && r.status === RoundStatus.Settled && r.creatorFee > 0n && stakes.get(r.id.toString())?.creatorFeeClaimed === true,
  );
}

export type MeRoundTotals = {
  /// Stakes still riding: rounds without a result, and refunds that qualify but are not marked yet.
  inPlay: bigint;
  /// Payouts of every round won, claimed or not (the pools' "Won all time" rule).
  wonAllTime: bigint;
  /// Claimable now, newest round first.
  claims: MeRound[];
  claimedBefore: boolean;
};

export function meRoundTotals(rs: readonly MeRound[]): MeRoundTotals {
  let inPlay = 0n;
  let wonAllTime = 0n;
  let claimedBefore = false;
  for (const r of rs) {
    const p = r.position;
    if (p.kind === 'in' || (p.kind === 'refund' && !p.marked)) inPlay += p.amount;
    if (p.kind === 'won') wonAllTime += p.payout;
    if ((p.kind === 'won' || p.kind === 'refund') && p.claimed) claimedBefore = true;
  }
  return { inPlay, wonAllTime, claims: rs.filter((r) => r.claim !== null), claimedBefore };
}
