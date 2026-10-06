// Rounds as the screens read them: one round's on-chain record, its phase at a given second, the money a stake
// would pay, and the plain-words commentary line. Pure functions over the contract's own values, so every number
// a player sees is computed the way MakoRoundsV1 computes it (mako-design/blueprint/SPEC.md §3, §7).

/// The asset a v1 round is on. MakoRoundsV1 is BTC/USD only (its FEED_ID is fixed); the screens draw the asset
/// from here so a later multi-asset contract adds entries rather than rewriting components.
export type RoundAsset = { symbol: string; pair: string; name: string };
export const V1_ASSET: RoundAsset = { symbol: 'BTC', pair: 'BTC/USD', name: 'Bitcoin' };

/// MakoRoundsV1's fixed values (SPEC §4), restated for display; the contract enforces them.
export const ENTRY_LEAD_S = 60;
export const DURATION_S = 900;
export const SUBMIT_WINDOW_S = 86_400;
export const MIN_LEAD_S = 600;
export const MAX_LEAD_S = 7 * 86_400;
export const BOUNDARY_STEP_S = 60;
export const PROTOCOL_FEE_BPS = 100n;
export const CREATOR_FEE_BPS = 200n;
/// 0.10 USDC, in base units.
export const MIN_ENTRY = 100_000n;

export enum RoundStatus {
  None = 0,
  Active = 1,
  Settled = 2,
  Refunded = 3,
}
export enum RoundOutcome {
  None = 0,
  Up = 1,
  Down = 2,
}
export enum RefundReason {
  None = 0,
  OneSided = 1,
  Tie = 2,
  NoPrice = 3,
}
export type RoundSide = 'up' | 'down';

/// One round, as `roundOf` returns it plus its id.
export type Round = {
  id: bigint;
  creator: `0x${string}`;
  openTime: number;
  startTime: number;
  status: RoundStatus;
  outcome: RoundOutcome;
  refundReason: RefundReason;
  /// int192, 18 decimals; 0 until settled.
  anchorPrice: bigint;
  closePrice: bigint;
  upPool: bigint;
  downPool: bigint;
  upEntrants: number;
  downEntrants: number;
  protocolFee: bigint;
  creatorFee: bigint;
  distributable: bigint;
};

export const entryCloseOf = (r: Round) => r.startTime - ENTRY_LEAD_S;
export const closeTimeOf = (r: Round) => r.startTime + DURATION_S;
export const submitDeadlineOf = (r: Round) => closeTimeOf(r) + SUBMIT_WINDOW_S;

/// What a player can do with a round right now. The contract's own phase (`phaseOf`) has Locked from entry close to
/// the close; the screens split it at the start so "starting" and "live" read differently.
export type RoundPhase = 'open' | 'starting' | 'live' | 'settling' | 'settled' | 'refunded';

export function phaseAt(r: Round, nowS: number): RoundPhase {
  if (r.status === RoundStatus.Settled) return 'settled';
  if (r.status === RoundStatus.Refunded) return 'refunded';
  if (nowS >= closeTimeOf(r)) return 'settling';
  if (nowS >= r.startTime) return 'live';
  if (nowS >= entryCloseOf(r)) return 'starting';
  return 'open';
}

/// A round that will refund rather than settle, before anyone has marked it: one side empty once entries closed
/// (from entry close), or no settlement by the submit deadline. Mirrors `finalizeRefund`'s two reasons.
export function pendingRefund(r: Round, nowS: number): RefundReason {
  if (r.status !== RoundStatus.Active) return RefundReason.None;
  if (nowS >= entryCloseOf(r) && (r.upPool === 0n || r.downPool === 0n)) return RefundReason.OneSided;
  if (nowS >= submitDeadlineOf(r)) return RefundReason.NoPrice;
  return RefundReason.None;
}

/// SPEC §7: fees on a settled round. Floor division, as the contract does.
export function feesOf(up: bigint, down: bigint): { protocolFee: bigint; creatorFee: bigint; distributable: bigint } {
  const total = up + down;
  const protocolFee = (total * PROTOCOL_FEE_BPS) / 10_000n;
  const smaller = up < down ? up : down;
  const creatorFee = (smaller * CREATOR_FEE_BPS) / 10_000n;
  return { protocolFee, creatorFee, distributable: total - protocolFee - creatorFee };
}

/// What `stake` on `side` would pay if that side wins, given the pools as they stand (stake already included).
export function payoutIfWins(side: RoundSide, stake: bigint, up: bigint, down: bigint): bigint {
  const winning = side === 'up' ? up : down;
  if (stake === 0n || winning === 0n) return 0n;
  return (stake * feesOf(up, down).distributable) / winning;
}

/// The estimate before entering: the pools grow by `amount` on `side`, and the player's stake is `existing + amount`.
export function estimateEntry(side: RoundSide, amount: bigint, existing: bigint, up: bigint, down: bigint): bigint {
  const u = side === 'up' ? up + amount : up;
  const d = side === 'down' ? down + amount : down;
  return payoutIfWins(side, existing + amount, u, d);
}

/// What one USDC on each side would return if it wins now, for the odds line; null when that side is empty.
export function perOneUsdc(up: bigint, down: bigint): { up: number | null; down: number | null } {
  const { distributable } = feesOf(up, down);
  const each = (w: bigint) => (w === 0n ? null : Number((distributable * 10_000n) / w) / 10_000);
  return { up: each(up), down: each(down) };
}

/// A settled round's payout for a stake on the winning side, from the contract's recorded distributable.
export function settledPayout(r: Round, stake: bigint): bigint {
  const winning = r.outcome === RoundOutcome.Up ? r.upPool : r.downPool;
  if (winning === 0n) return 0n;
  return (stake * r.distributable) / winning;
}

export type Stake = { side: RoundSide | null; amount: bigint };

/// The player's position in plain terms, for the position card and the claim button.
export type Position =
  | { kind: 'none' }
  | { kind: 'in'; side: RoundSide; amount: bigint; ifWins: bigint }
  | { kind: 'won'; side: RoundSide; amount: bigint; payout: bigint; claimed: boolean }
  | { kind: 'lost'; side: RoundSide; amount: bigint }
  | { kind: 'refund'; side: RoundSide; amount: bigint; claimed: boolean; marked: boolean };

export function positionOf(r: Round, stake: Stake, claimed: boolean, nowS: number): Position {
  if (!stake.side || stake.amount === 0n) return { kind: 'none' };
  const side = stake.side;
  if (r.status === RoundStatus.Refunded) return { kind: 'refund', side, amount: stake.amount, claimed, marked: true };
  if (r.status === RoundStatus.Settled) {
    const won = (r.outcome === RoundOutcome.Up) === (side === 'up');
    return won ? { kind: 'won', side, amount: stake.amount, payout: settledPayout(r, stake.amount), claimed } : { kind: 'lost', side, amount: stake.amount };
  }
  if (pendingRefund(r, nowS) !== RefundReason.None) return { kind: 'refund', side, amount: stake.amount, claimed: false, marked: false };
  return { kind: 'in', side, amount: stake.amount, ifWins: payoutIfWins(side, stake.amount, r.upPool, r.downPool) };
}

/// The price as players read it: dollars with cents, from the report's 18-decimal integer.
export function priceUsd(p: bigint): string {
  const cents = (p + 5n * 10n ** 15n) / 10n ** 16n;
  const whole = cents / 100n;
  return `$${whole.toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/// The move from anchor to close, as a signed percentage with two decimals.
export function movePct(anchor: bigint, close: bigint): string {
  if (anchor <= 0n) return '0.00%';
  const bp = ((close - anchor) * 1_000_000n) / anchor; // ten-thousandths of a percent
  const sign = bp > 0n ? '+' : bp < 0n ? '−' : '';
  const abs = bp < 0n ? -bp : bp;
  const hundredths = (abs + 50n) / 100n;
  return `${sign}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
}

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 100n + total / 2n) / total));

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const usd2 = (base: bigint) => {
  const cents = (base + 5_000n) / 10_000n;
  return `${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
};

/// One line of live commentary, built only from the round's real numbers and the clock: never a price or a count the
/// chain does not hold. Plain words, no em dashes, no "we".
export function commentary(r: Round, nowS: number, asset: RoundAsset = V1_ASSET): string {
  const total = r.upPool + r.downPool;
  const players = r.upEntrants + r.downEntrants;
  const phase = phaseAt(r, nowS);
  const lead = () => {
    if (total === 0n) return 'Nobody has picked a side yet.';
    if (r.upPool === 0n || r.downPool === 0n) {
      const only = r.upPool === 0n ? 'DOWN' : 'UP';
      return `Only ${only} has money so far. A round needs both sides, or everyone is refunded.`;
    }
    const u = pct(r.upPool, total);
    if (u === 50) return `Dead even: ${usd2(total)} USDC split down the middle.`;
    return u > 50 ? `UP leads ${u}/${100 - u} with ${usd2(total)} USDC in the pot.` : `DOWN leads ${100 - u}/${u} with ${usd2(total)} USDC in the pot.`;
  };
  switch (phase) {
    case 'open':
      return `${lead()} ${players} ${players === 1 ? 'player' : 'players'} in. Predictions close in ${mmss(entryCloseOf(r) - nowS)}.`;
    case 'starting':
      return pendingRefund(r, nowS) === RefundReason.OneSided
        ? 'Predictions are closed with only one side in, so this round will refund everyone.'
        : `Predictions are closed. ${asset.symbol}'s starting price is taken in ${mmss(r.startTime - nowS)}.`;
    case 'live':
      return pendingRefund(r, nowS) === RefundReason.OneSided
        ? 'Only one side came in, so this round refunds everyone when it is marked.'
        : `Live. ${mmss(closeTimeOf(r) - nowS)} until the closing price decides it. ${lead()}`;
    case 'settling':
      return pendingRefund(r, nowS) === RefundReason.OneSided
        ? 'Only one side came in, so everyone gets their stake back.'
        : 'The round is over. Waiting for the two signed Chainlink prices to settle it on chain.';
    case 'settled': {
      const winner = r.outcome === RoundOutcome.Up ? 'UP' : 'DOWN';
      return `${asset.symbol} went ${priceUsd(r.anchorPrice)} to ${priceUsd(r.closePrice)} (${movePct(r.anchorPrice, r.closePrice)}). ${winner} takes ${usd2(r.distributable)} USDC.`;
    }
    case 'refunded':
      return r.refundReason === RefundReason.Tie
        ? `A tie: ${asset.symbol} closed exactly where it started, so everyone gets their stake back.`
        : r.refundReason === RefundReason.OneSided
          ? 'Only one side came in, so everyone gets their stake back.'
          : 'No signed price arrived in time, so everyone gets their stake back.';
  }
}

/// Is `startTime` (unix seconds) a time a creator may schedule from `nowS`? SPEC §4: a whole minute, 10 minutes
/// to 7 days ahead. Returns the reason in plain words when it is not.
export function scheduleBlocker(startTime: number, nowS: number): string | null {
  if (!Number.isInteger(startTime) || startTime % BOUNDARY_STEP_S !== 0) return 'Pick a start on a whole minute.';
  if (startTime < nowS + MIN_LEAD_S) return 'A round must start at least 10 minutes from now.';
  if (startTime > nowS + MAX_LEAD_S) return 'A round can start at most 7 days from now.';
  return null;
}
