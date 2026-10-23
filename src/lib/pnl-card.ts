// The share cards (docs/pnl-share-card/SPEC.md): every figure for one bet, from the pool and the bet's own BetPlaced
// log. Pure, so the per-bet maths and the formatting are tested without a chain or a renderer.
//
// One card per bet (owner, 2026-10-23): two bets on one pool are two cards. While the pool is unsettled the bet has a
// "bet placed" card; once it settles YES or NO, a win or loss card. A bet's payout is the contract's pro-rata for its
// own amount (computeResolvedClaim, the formula `claim()` uses for a side's whole stake); a bet on the losing side pays
// 0. A refunded pool has no card.

import { decodeEventLog, type Hex } from 'viem';

import { computeResolvedClaim } from './bet';
import { MAKO_ADDRESS, makoAbi, marketTypeLabel, Outcome, type MarketWithId } from './contract';
import { usdc2 } from './pool-list';
import { priceTarget } from './pool-create';
import { parseOracleRef, unsettleable } from './pool-rules';

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
  target: string | null;
};

/// The bet placed card: shared while the pool is unsettled (SPEC.md, "Bet placed variant").
export type PlacedCard = {
  variant: 'placed';
  category: string;
  question: string;
  questionPx: number;
  /// The headline: YES / NO, or a house pool's own name, shortened to fit.
  side: string;
  sidePx: number;
  isYes: boolean;
  stake: string;
  /// What this bet pays if its side wins with the pot as it stands now, fees included. Null while nobody is on the
  /// other side: the stake back is not an estimate worth a card (the spec drops the fields rather than guess).
  est: { payout: string; ret: Signed } | null;
  /// Betting has closed, so the pot no longer moves.
  potFinal: boolean;
  /// "Sat 25 Oct": the pool's close, after which Mako Market settles it. Null for a pool the resolver cannot read,
  /// which is never settled automatically.
  settles: string | null;
  /// The bet's own date, "23 OCT 2026".
  date: string;
  target: string | null;
};

export type ShareCard = PnlCard | PlacedCard;

/// Which card a link asks for. It is part of the URL, so a cached bet placed card can never stand in for the result.
export type CardState = 'placed' | 'result';
export const CARD_STATES: readonly CardState[] = ['placed', 'result'];

/// A price pool's target, "Above $83,368" or "Below 1.1", from its settlement reference on chain, formatted as the
/// pool's title shows it; null for sports and house pools, and for a reference the resolver cannot read. Entry and
/// current prices come later, from the price recorder (owner, 2026-10-23: Data Streams, the feed that settles).
export function cardTarget(m: Pick<MarketWithId, 'mType' | 'oracleRef'>): string | null {
  const ref = parseOracleRef(m);
  if (ref?.kind !== 'price') return null;
  const t = priceTarget(m.mType, ref.strike);
  return t === null ? null : `${ref.op === 'gt' ? 'Above' : 'Below'} ${t}`;
}

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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/// "Sat 25 Oct", in UTC like the card date.
export function settleDay(sec: bigint): string {
  const d = new Date(Number(sec) * 1000);
  const mon = MONTHS[d.getUTCMonth()];
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${mon[0]}${mon.slice(1).toLowerCase()}`;
}

/// The bet placed headline's size: the design's 186px for YES or NO, smaller for a long house side name so it ends
/// within about 900px, clear of the art (Bricolage 800 caps run about 0.62em).
export function sidePx(side: string): number {
  return Math.min(186, Math.floor(900 / (0.62 * [...side].length)));
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
    target: cardTarget(m),
  };
}

/// The bet placed card for one bet, or null once the pool is settled (or for an empty bet).
export function placedCard(m: MarketWithId, bet: CardBet, labels: { yes: string; no: string }, betAtSec: bigint, nowSec: number): PlacedCard | null {
  if (m.resolved || bet.amount <= 0n) return null;
  const [mine, other] = bet.isYes ? [m.totalYes, m.totalNo] : [m.totalNo, m.totalYes];
  const payout = other === 0n ? null : computeResolvedClaim(mine, other, bet.amount, BigInt(m.protocolFeeBpsSnapshot), BigInt(m.creatorFeeBpsSnapshot));
  const side = shortSide(bet.isYes ? labels.yes : labels.no);
  return {
    variant: 'placed',
    category: `The call · ${marketTypeLabel(m.mType)} pool`,
    question: m.question,
    questionPx: questionPx(m.question),
    side,
    sidePx: sidePx(side),
    isYes: bet.isYes,
    stake: usdc2(bet.amount),
    est: payout === null ? null : { payout: usdc2(payout), ret: returnPct(payout, bet.amount) },
    potFinal: nowSec >= Number(m.bettingCloseTime),
    settles: unsettleable(m) ? null : settleDay(m.closeTime),
    date: cardDate(betAtSec),
    target: cardTarget(m),
  };
}

/// One bet's card page; its image is this path + "/opengraph-image". The hash is lower-case, the one form served.
export const cardPath = (poolId: bigint | string, tx: string, logIndex: number | string, state: CardState) =>
  `/pools/${poolId.toString()}/pnl/${tx.toLowerCase()}/${logIndex.toString()}/${state}`;

type ReceiptLog = { address: string; logIndex: number | null; data: Hex; topics: readonly Hex[] };

/// The log index of the account's bet on this pool in a bet transaction's receipt: the one BetPlaced log the live
/// contract emitted for it. Null when there is none or more than one, so a Share button never guesses which bet.
export function betLogIndex(logs: readonly ReceiptLog[], poolId: bigint, account: string): number | null {
  const hits = logs.flatMap((l) => {
    if (l.logIndex === null || l.address.toLowerCase() !== MAKO_ADDRESS.toLowerCase()) return [];
    try {
      const ev = decodeEventLog({ abi: makoAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: true });
      return ev.eventName === 'BetPlaced' && ev.args.id === poolId && ev.args.user.toLowerCase() === account.toLowerCase() ? [l.logIndex] : [];
    } catch {
      return [];
    }
  });
  return hits.length === 1 ? hits[0] : null;
}
