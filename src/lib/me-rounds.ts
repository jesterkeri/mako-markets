// Rounds in Me (Joshua 2026-10-13: "users can only claim rounds earnings from the rounds tab ... let it appear in me
// too"): the account's round positions as Me's totals and claims, beside its pools. Pure; read by use-me-rounds.ts.

import { positionOf, type Position, type Round, type Stake } from './rounds-model';

export type MeRound = {
  round: Round;
  position: Position;
  /// What `claim(roundId)` pays now, or null: a win not yet claimed, or a refund marked on chain and not yet claimed.
  /// A refund that qualifies but is not marked yet is not claimable from Me (the round page marks it first).
  claim: bigint | null;
};

export type RoundStakeRead = { stake: Stake; claimed: boolean };

/// Every round this account has a stake in, newest first.
export function meRoundPositions(rounds: readonly Round[], stakes: ReadonlyMap<string, RoundStakeRead>, nowS: number): MeRound[] {
  const out: MeRound[] = [];
  for (const round of rounds) {
    const s = stakes.get(round.id.toString());
    if (!s || !s.stake.side || s.stake.amount === 0n) continue;
    const position = positionOf(round, s.stake, s.claimed, nowS);
    if (position.kind === 'none') continue;
    out.push({ round, position, claim: claimOf(position) });
  }
  return out.sort((a, b) => (a.round.id === b.round.id ? 0 : a.round.id > b.round.id ? -1 : 1));
}

function claimOf(p: Position): bigint | null {
  if (p.kind === 'won' && !p.claimed && p.payout > 0n) return p.payout;
  if (p.kind === 'refund' && p.marked && !p.claimed) return p.amount;
  return null;
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
