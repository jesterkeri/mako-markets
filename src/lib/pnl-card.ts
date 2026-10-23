// The PnL share card (docs/pnl-share-card/SPEC.md): every figure for one bet, from the pool and the bet's own
// BetPlaced log. Pure, so the per-bet maths and the formatting are tested without a chain or a renderer.
//
// One card per bet (owner, 2026-10-23): two bets on one pool are two cards. A bet's payout is the contract's pro-rata
// for its own amount (computeResolvedClaim, the formula `claim()` uses for a side's whole stake); a bet on the losing
// side pays 0. Refunded or unresolved pools have no card.

import { computeResolvedClaim } from './bet';
import { marketTypeLabel, Outcome, type MarketWithId } from './contract';
import { usdc2 } from './pool-list';

export type CardBet = { isYes: boolean; amount: bigint };

export type Signed = { sign: '+' | '-' | ''; text: string };

export type PnlCard = {
  variant: 'win' | 'loss';
  /// "The call · FOOTBALL pool" (the card prints it uppercase).
  category: string;
  question: string;
  /// The question's size: one line at the design's 66px, smaller and clamped to two lines when longer.
  questionPx: number;
  /// The side's name: YES / NO, or a house pool's own name, shortened to fit the pill.
  side: string;
  stake: string;
  payout: string;
  /// Payout minus stake: "+6.17 USDC" / "-10.00 USDC" (sign kept apart: the card spaces it).
  net: Signed;
  /// The word after it: "loss" whenever the bet lost money, even on the winning side (a win that paid back less than
  /// its stake), else "profit".
  netWord: 'profit' | 'loss';
  /// "+61.7%", "-100%".
  ret: Signed;
  /// The pool's close date, UTC: "23 OCT 2026" (V4 stores no settlement time; Me orders by close too).
  date: string;
};

/// What `claim()` pays for this one bet, or null when the pool has no win or loss result (unresolved, or refunded).
export function betPayout(m: MarketWithId, bet: CardBet): bigint | null {
  if (!m.resolved || (m.outcome !== Outcome.YES && m.outcome !== Outcome.NO)) return null;
  const yesWon = m.outcome === Outcome.YES;
  if (bet.isYes !== yesWon) return 0n;
  const [winnerPool, loserPool] = yesWon ? [m.totalYes, m.totalNo] : [m.totalNo, m.totalYes];
  return computeResolvedClaim(winnerPool, loserPool, bet.amount, BigInt(m.protocolFeeBpsSnapshot), BigInt(m.creatorFeeBpsSnapshot));
}

/// "+6.17", "-10.00"; a value that rounds to 0.00 has no sign.
export function signedAmount(v: bigint): Signed {
  const text = usdc2(v < 0n ? -v : v);
  return { sign: text === '0.00' ? '' : v > 0n ? '+' : v < 0n ? '-' : '', text };
}

/// (payout - stake) / stake to one decimal, half away from zero, without a trailing ".0": "+61.7%", "-100%".
export function returnPct(payout: bigint, stake: bigint): Signed {
  const net = payout - stake;
  const abs = net < 0n ? -net : net;
  const tenths = (abs * 2000n + stake) / (2n * stake);
  const whole = (tenths / 10n).toString();
  const frac = tenths % 10n;
  return { sign: tenths === 0n ? '' : net > 0n ? '+' : '-', text: `${whole}${frac === 0n ? '' : `.${frac}`}%` };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/// "23 OCT 2026", in UTC so every viewer sees the same date.
export function cardDate(sec: bigint): string {
  const d = new Date(Number(sec) * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/// The approved design fits about 32 characters on one line at 66px in the 900px column (measured at about 0.42em a
/// character). Longer steps down so two lines hold it with room for word wrapping, and the card clamps it to two lines:
/// at 50px or less two lines end by 282px, above the Return block (top 300px).
export function questionPx(q: string): number {
  const n = [...q].length;
  return n <= 32 ? 66 : n <= 64 ? 50 : n <= 80 ? 46 : 40;
}

const SIDE_MAX = 10;

/// A side name that fits the pill: up to 10 characters, else 9 and an ellipsis.
export function shortSide(name: string): string {
  const chars = [...name.trim()];
  return chars.length <= SIDE_MAX ? chars.join('') : `${chars.slice(0, SIDE_MAX - 1).join('').trimEnd()}…`;
}

/// The card for one bet, or null when the pool has no win or loss result.
export function pnlCard(m: MarketWithId, bet: CardBet, labels: { yes: string; no: string }): PnlCard | null {
  const payout = betPayout(m, bet);
  if (payout === null || bet.amount <= 0n) return null;
  const won = bet.isYes === (m.outcome === Outcome.YES);
  return {
    variant: won ? 'win' : 'loss',
    category: `The call · ${marketTypeLabel(m.mType)} pool`,
    question: m.question,
    questionPx: questionPx(m.question),
    side: shortSide(bet.isYes ? labels.yes : labels.no),
    stake: usdc2(bet.amount),
    payout: usdc2(payout),
    net: signedAmount(payout - bet.amount),
    netWord: payout < bet.amount ? 'loss' : 'profit',
    ret: returnPct(payout, bet.amount),
    date: cardDate(m.closeTime),
  };
}

/// One bet's card page; its image is this path + "/opengraph-image". The hash is lower-case, the one form served.
export const cardPath = (poolId: bigint | string, tx: string, logIndex: number | string) =>
  `/pools/${poolId.toString()}/pnl/${tx.toLowerCase()}/${logIndex.toString()}`;
