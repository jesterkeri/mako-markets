'use client';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useState } from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { ListStateDesktop } from '@/components/ListState';
import { SignInLink } from '@/components/signin/SignInLink';
import { useUsdcBalance } from '@/lib/hooks';
import { parseAmount } from '@/lib/pool-bet-rules';
import { usdc2, usdcExact } from '@/lib/pool-list';
import {
  closeTimeOf,
  commentary,
  entryCloseOf,
  estimateEntry,
  feesOf,
  MIN_ENTRY,
  mmss,
  movePct,
  pendingRefund,
  perOneUsdc,
  phaseAt,
  positionOf,
  priceUsd,
  RefundReason,
  RoundOutcome,
  submitDeadlineOf,
  usdcFloor2,
  V1_ASSET,
  type Position,
  type Round,
  type RoundPhase,
  type RoundSide,
} from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { useRoundTx, type RoundTx } from '@/lib/use-round-tx';
import { useCreatorFeeClaimed, useRound, useRoundStake } from '@/lib/use-rounds';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const CHIPS = ['0.10', '1', '5', '10', '25', '50'];

const clock = (unixS: number) => new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const clockSec = (unixS: number) => new Date(unixS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function walletOf(user: AuthedUser): { kind: 'mako' | 'external'; address: string } {
  return user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress };
}

export function RoundClient({ id, initialSide }: { id: bigint; initialSide: RoundSide | null }) {
  const state = useRound(id);
  const now = useLiveNowSec();
  const { user } = useUser();
  const account = user ? accountAddress(user) : null;
  const stakeQ = useRoundStake(id, account);
  const balanceQ = useUsdcBalance(account ?? undefined);
  const balance = typeof balanceQ.data === 'bigint' ? balanceQ.data : null;
  const round = state.kind === 'ready' ? state.round : null;
  const isCreatorOfRound = round !== null && account !== null && round.creator.toLowerCase() === account.toLowerCase();
  const creatorFeeClaimed = useCreatorFeeClaimed(id, isCreatorOfRound);

  const tx = useRoundTx(() => {
    if (state.kind === 'ready') state.refetch();
    stakeQ?.refetch();
    void balanceQ.refetch();
  });
  const [side, setSide] = useState<RoundSide>(initialSide ?? 'up');
  const [amountText, setAmountText] = useState('5');
  const [sheetSpec, setSheetSpec] = useState<ConfirmSpec | null>(null);

  if (state.kind === 'missing') notFound();
  if (state.kind === 'off') {
    return (
      <div className="mk-desk-frame" style={{ padding: '24px 4px' }}>
        <ListStateDesktop kind="rounds" state="not_open" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="mk-desk-frame" style={{ padding: '24px 4px' }}>
        <ListStateDesktop kind="rounds" state="error" onRetry={state.retry} />
      </div>
    );
  }
  if (!round || now === null) {
    return (
      <div className="mk-desk-frame" style={{ padding: '24px 4px' }}>
        <ListStateDesktop kind="rounds" state="loading" />
      </div>
    );
  }

  const phase = phaseAt(round, now);
  // Signed in but the stake not read yet: unknown, not "none" (adversary on 44aa10d). No side choice, no
  // prediction and no claim until it is known.
  const stakeKnown = user === null || stakeQ !== null;
  const stake = stakeQ?.stake ?? { side: null, amount: 0n };
  const position = positionOf(round, stake, stakeQ?.claimed ?? false, now);
  // One wallet, one side (N12): once in, the side is fixed.
  const effectiveSide: RoundSide = stake.side ?? side;
  const amount = parseAmount(amountText);
  const why = stakeKnown ? enterBlocker({ phase, amount, balance, signedIn: user !== null }) : 'Checking your position in this round…';
  const estimate = amount && amount > 0n ? estimateEntry(effectiveSide, amount, stake.amount, round.upPool, round.downPool) : null;
  const creatorFeeDue = isCreatorOfRound && phase === 'settled' && round.creatorFee > 0n && creatorFeeClaimed === false ? round.creatorFee : null;

  const openTx = (t: RoundTx, spec: ConfirmSpec) => {
    if (tx.tx) return;
    setSheetSpec(spec);
    tx.open(t);
  };
  const openEnter = () => {
    if (amount === null || why) return;
    openTx({ kind: 'enter', roundId: id, side: effectiveSide, amount }, enterSpec(round, effectiveSide, amount, estimate));
  };
  const claimAmount = stakeKnown ? claimable(position) + (creatorFeeDue ?? 0n) : 0n;
  const openClaim = () => openTx({ kind: 'claim', roundId: id }, claimSpec(round, position, creatorFeeDue, claimAmount));
  const refundToMark = pendingRefund(round, now);
  const openMarkRefund = () => openTx({ kind: 'refund', roundId: id }, markRefundSpec(round, refundToMark));

  const view: View = {
    round,
    phase,
    now,
    position,
    signedIn: user !== null,
    balance,
    side: effectiveSide,
    sideLocked: stake.side !== null,
    setSide,
    amountText,
    setAmountText,
    amount,
    estimate,
    why,
    openEnter,
    claimAmount,
    creatorFeeDue,
    openClaim,
    refundToMark,
    openMarkRefund,
  };

  const spec = tx.tx ? sheetSpec : null;
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <RoundView {...view} narrow={false} />
      </div>
      <div className="mk-mob mk-m">
        <RoundView {...view} narrow />
      </div>
      {spec && user && <ConfirmSheet spec={spec} phase={tx.phase} wallet={walletOf(user)} onConfirm={tx.confirm} onCancel={tx.close} onRetry={tx.retry} onClose={tx.close} />}
    </>
  );
}

export type View = {
  round: Round;
  phase: RoundPhase;
  now: number;
  position: Position;
  signedIn: boolean;
  balance: bigint | null;
  side: RoundSide;
  sideLocked: boolean;
  setSide: (s: RoundSide) => void;
  amountText: string;
  setAmountText: (s: string) => void;
  amount: bigint | null;
  estimate: bigint | null;
  why: string | null;
  openEnter: () => void;
  claimAmount: bigint;
  creatorFeeDue: bigint | null;
  openClaim: () => void;
  refundToMark: RefundReason;
  openMarkRefund: () => void;
};

function enterBlocker(a: { phase: RoundPhase; amount: bigint | null; balance: bigint | null; signedIn: boolean }): string | null {
  if (a.phase !== 'open') return 'Predictions are closed for this round.';
  if (a.amount === null) return 'Enter an amount in USDC, for example 5 or 2.50.';
  if (a.amount < MIN_ENTRY) return 'The minimum prediction is 0.10 USDC.';
  if (a.signedIn && a.balance !== null && a.amount > a.balance) return 'That is more USDC than your balance.';
  return null;
}

function claimable(p: Position): bigint {
  if (p.kind === 'won' && !p.claimed) return p.payout;
  if (p.kind === 'refund' && p.marked && !p.claimed) return p.amount;
  return 0n;
}

const sideName = (s: RoundSide) => (s === 'up' ? 'UP' : 'DOWN');

function enterSpec(r: Round, side: RoundSide, amount: bigint, estimate: bigint | null): ConfirmSpec {
  const amt = usdcExact(amount);
  return {
    glyph: side === 'up' ? '↑' : '↓',
    glyphColor: side === 'up' ? 'var(--mako-signal)' : 'var(--mako-red)',
    title: `${sideName(side)} · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: 'Placing your prediction',
    rows: [
      { label: 'Round', value: `#${r.id.toString()} · ${V1_ASSET.pair} · ${clock(r.startTime)} to ${clock(closeTimeOf(r))}` },
      { label: 'Side', value: sideName(side), tone: side === 'up' ? 'up' : 'no' },
      { label: 'Stake', value: `${amt} USDC` },
      { label: `Est. payout if ${sideName(side)} wins`, value: estimate === null ? 'Unknown' : `${usdcFloor2(estimate)} USDC` },
    ],
    note: `The payout is an estimate until predictions close at ${clock(entryCloseOf(r))}. One wallet can only be on one side of a round.`,
    doneTitle: 'You are in',
    doneBody: `${amt} USDC on ${sideName(side)}. The result comes at ${clock(closeTimeOf(r))}.`,
    doneSecondary: { label: 'View in Me', href: '/me' },
  };
}

function claimSpec(r: Round, p: Position, creatorFee: bigint | null, total: bigint): ConfirmSpec {
  const amt = usdcExact(total);
  const refund = p.kind === 'refund';
  const rows: ConfirmSpec['rows'] = [{ label: 'Round', value: `#${r.id.toString()} · ${V1_ASSET.pair}` }];
  if (p.kind === 'won') rows.push({ label: 'Payout', value: `${usdcExact(p.payout)} USDC` });
  if (refund) rows.push({ label: 'Refund', value: `${usdcExact(p.amount)} USDC` });
  if (creatorFee) rows.push({ label: 'Creator fee', value: `${usdcExact(creatorFee)} USDC` });
  return {
    glyph: '$',
    glyphColor: 'var(--mako-teal)',
    title: `${refund ? 'Claim refund' : 'Claim'} · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: refund ? 'Claiming your refund' : 'Claiming',
    rows,
    note: refund ? 'A refund returns your full stake, with no fee.' : 'Fees were taken when the round settled; the claim pays out the rest.',
    doneTitle: refund ? 'Refund claimed' : 'Claimed',
    doneBody: `${amt} USDC is in your balance.`,
    doneSecondary: { label: 'View in Me', href: '/me' },
  };
}

function markRefundSpec(r: Round, reason: RefundReason): ConfirmSpec {
  return {
    glyph: '↺',
    glyphColor: 'var(--mako-teal)',
    title: 'Mark this round refunded',
    confirmLabel: 'Confirm',
    pendingTitle: 'Marking the refund',
    rows: [
      { label: 'Round', value: `#${r.id.toString()} · ${V1_ASSET.pair}` },
      { label: 'Why', value: reason === RefundReason.OneSided ? 'Only one side had predictions' : 'No signed price within 24H of the close' },
    ],
    note: 'Anyone may mark a round refunded once it qualifies. Then every player claims their full stake back, no fee.',
    doneTitle: 'Round refunded',
    doneBody: 'Everyone in this round can now claim their stake back.',
  };
}

// ---------------------------------------------------------------------------------------------------------------

function countdown(r: Round, phase: RoundPhase, now: number): { label: string; value: string; sub: string } {
  switch (phase) {
    case 'open':
      return { label: 'Predictions close in', value: mmss(entryCloseOf(r) - now), sub: `The starting price is taken at ${clockSec(r.startTime)}.` };
    case 'starting':
      return { label: 'Starts in', value: mmss(r.startTime - now), sub: `Predictions closed at ${clock(entryCloseOf(r))}.` };
    case 'live':
      return { label: 'Result in', value: mmss(closeTimeOf(r) - now), sub: `The closing price at ${clockSec(closeTimeOf(r))} decides it.` };
    case 'settling':
      return { label: 'Settling', value: '…', sub: `Waiting for both signed prices. If none arrive by ${clock(submitDeadlineOf(r))} tomorrow, everyone is refunded.` };
    case 'settled':
      return { label: 'Result', value: r.outcome === RoundOutcome.Up ? 'UP' : 'DOWN', sub: 'Settled on chain from two signed Chainlink prices.' };
    case 'refunded':
      return { label: 'Result', value: 'Refund', sub: 'Everyone gets their full stake back, no fee.' };
  }
}

export function RoundView(v: View & { narrow: boolean }) {
  const { round: r, phase, now, narrow } = v;
  const cd = countdown(r, phase, now);
  const actions = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {v.position.kind !== 'none' && <PositionCard {...v} />}
      {v.creatorFeeDue !== null && v.position.kind === 'none' && <CreatorFee {...v} />}
      {phase === 'open' && <EnterForm {...v} />}
      {v.refundToMark !== RefundReason.None && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            {v.refundToMark === RefundReason.OneSided ? 'Only one side came in, so this round refunds everyone.' : 'No signed price arrived within 24H of the close, so this round refunds everyone.'} The settlement keeper marks it shortly; anyone may do it now.
          </div>
          {v.signedIn && (
            <button onClick={v.openMarkRefund} className="mk-press96" style={{ height: 48, borderRadius: 9999, boxShadow: 'inset 0 0 0 1.5px var(--edge-c)', ...display, fontSize: 15 }}>
              Mark refunded
            </button>
          )}
        </div>
      )}
    </div>
  );
  const details = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
      <Pots {...v} />
      {phase === 'settled' && <Receipt round={r} />}
      <HowItWorks />
    </div>
  );
  return (
    // Mobile pages carry their own 20px side margin (the shell's mobile frame has none).
    <div style={{ paddingBottom: 32, padding: narrow ? '0 20px 32px' : undefined }}>
      <div style={{ padding: narrow ? '12px 0 0' : '14px 4px 0' }}>
        <Link href="/rounds" style={{ ...mono, fontSize: 12, color: 'var(--dim)', textDecoration: 'none' }}>
          ← ROUNDS
        </Link>
      </div>
      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: narrow ? 'flex-start' : 'flex-end', justifyContent: 'space-between', gap: narrow ? 14 : 32, padding: narrow ? '10px 0 16px' : '10px 4px 22px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>
            ROUND #{r.id.toString()} · {V1_ASSET.pair} · {clock(r.startTime)} to {clock(closeTimeOf(r))}
          </div>
          <h1 style={{ margin: '10px 0 0', ...display, fontSize: narrow ? 34 : 52, lineHeight: 1.02, letterSpacing: '-0.035em' }}>
            {V1_ASSET.symbol} up or down by {clock(closeTimeOf(r))}?
          </h1>
        </div>
        <div style={{ flex: 'none', textAlign: narrow ? 'left' : 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--dim)' }}>{cd.label}</div>
          <div style={{ ...display, fontSize: narrow ? 56 : 84, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', marginTop: 4 }}>{cd.value}</div>
          <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 6, maxWidth: 360 }}>{cd.sub}</div>
        </div>
      </div>

      <div role="status" aria-live="polite" style={{ padding: '12px 16px', borderRadius: 12, background: 'var(--raise)', boxShadow: 'var(--edge)', fontSize: 15, lineHeight: 1.5 }}>
        <span style={{ ...mono, fontSize: 10, fontWeight: 700, color: 'var(--dim)', marginRight: 8 }}>COMMENTARY</span>
        {commentary(r, now)}
      </div>

      {/* On mobile the player's position and the prediction form come first, above the details. */}
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'minmax(0,1fr)' : 'minmax(0,1fr) 380px', gap: narrow ? 20 : 28, marginTop: 22 }}>
        {narrow ? actions : details}
        {narrow ? details : actions}
      </div>
    </div>
  );
}

function Pots({ round: r, phase }: View) {
  const total = r.upPool + r.downPool;
  const upPct = total === 0n ? 50 : Number((r.upPool * 100n + total / 2n) / total);
  const odds = perOneUsdc(r.upPool, r.downPool);
  const final = phase !== 'open';
  const side = (s: RoundSide) => {
    const won = phase === 'settled' && (r.outcome === RoundOutcome.Up) === (s === 'up');
    const x = s === 'up' ? odds.up : odds.down;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: s === 'up' ? 'flex-start' : 'flex-end', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: s === 'up' ? 'row' : 'row-reverse' }}>
          <span style={{ ...display, fontSize: 22 }}>{s === 'up' ? '↑ UP' : 'DOWN ↓'}</span>
          {won && <span style={{ ...mono, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 9999, background: s === 'up' ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)' }}>WON</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexDirection: s === 'up' ? 'row' : 'row-reverse' }}>
          {x === null ? (
            <span style={{ ...display, fontSize: 22, color: 'var(--dim)' }}>No stake yet</span>
          ) : (
            <>
              <span style={{ ...display, fontSize: 48, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{x.toFixed(2)}x</span>
              <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>PER 1 USDC</span>
            </>
          )}
        </div>
      </div>
    );
  };
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: '0 4px' }}>
        {side('up')}
        {side('down')}
      </div>
      <div style={{ display: 'flex', height: 30, borderRadius: 9999, overflow: 'hidden', margin: '14px 4px 0', border: '1.5px solid var(--edge-c)', background: 'var(--raise2)' }}>
        {total > 0n && (
          <>
            <div style={{ width: `${upPct}%`, background: 'var(--mako-signal)', color: '#000', display: 'flex', alignItems: 'center', padding: '0 12px', ...mono, fontSize: 12, fontWeight: 700, minWidth: 52, transition: 'width 700ms cubic-bezier(0.23,1,0.32,1)' }}>{upPct}%</div>
            <div style={{ flex: 1, background: 'var(--mako-red)', borderLeft: '1.5px solid var(--edge-c)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 12px', ...mono, fontSize: 12, fontWeight: 700, minWidth: 52 }}>{100 - upPct}%</div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 4px 0', ...mono, fontSize: 13 }}>
        <span>
          <span style={{ fontWeight: 700 }}>{usdc2(r.upPool)} USDC</span> <span style={{ color: 'var(--dim)' }}>· {r.upEntrants} {r.upEntrants === 1 ? 'player' : 'players'}</span>
        </span>
        <span>
          <span style={{ color: 'var(--dim)' }}>{r.downEntrants} {r.downEntrants === 1 ? 'player' : 'players'} ·</span> <span style={{ fontWeight: 700 }}>{usdc2(r.downPool)} USDC</span>
        </span>
      </div>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', padding: '10px 4px 0', lineHeight: 1.5 }}>
        {final ? 'Final pots, set when predictions closed.' : 'Odds change until predictions close.'}{' '}Winners split the pot in proportion to their stake, after 1% to Mako Market and 2% of the smaller side to the house.
      </div>
    </div>
  );
}

function Receipt({ round: r }: { round: Round }) {
  const fees = feesOf(r.upPool, r.downPool);
  const rows = [
    { k: 'Starting price', v: `${priceUsd(r.anchorPrice)} at ${clockSec(r.startTime)}` },
    { k: 'Closing price', v: `${priceUsd(r.closePrice)} at ${clockSec(closeTimeOf(r))}` },
    { k: 'Move', v: movePct(r.anchorPrice, r.closePrice) },
    { k: 'Result', v: r.outcome === RoundOutcome.Up ? 'UP won' : 'DOWN won' },
    { k: 'Pot', v: `${usdc2(r.upPool + r.downPool)} USDC` },
    { k: 'Fees', v: `${usdc2(r.protocolFee || fees.protocolFee)} to Mako Market + ${usdc2(r.creatorFee || fees.creatorFee)} to the creator` },
    { k: 'To winners', v: `${usdc2(r.distributable)} USDC` },
    { k: 'Verified', v: 'On chain, by the Chainlink Data Streams verifier' },
  ];
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h2 style={{ margin: 0, padding: '0 4px', ...display, fontSize: 24, letterSpacing: '-0.02em' }}>Result receipt</h2>
      <div style={{ marginTop: 8 }}>
        {rows.map((x) => (
          <div key={x.k} style={{ display: 'grid', gridTemplateColumns: '140px minmax(0,1fr)', gap: 16, alignItems: 'center', padding: '10px 4px', boxShadow: 'inset 0 -1px 0 var(--line)', ...mono, fontSize: 13 }}>
            <span style={{ color: 'var(--dim)' }}>{x.k}</span>
            <span style={{ fontWeight: 700 }}>{x.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS = [
  ['01', 'Predict', 'Pick UP or DOWN with USDC before predictions close, one minute before the start. One wallet, one side.'],
  ['02', 'Start', "The starting price is Chainlink's signed BTC/USD price at exactly the start second."],
  ['03', '15 minutes', 'The round runs. The closing price is the signed price at exactly the end second.'],
  ['04', 'Result', 'Higher than the start: UP wins. Lower: DOWN wins. Exactly the same: a tie, and everyone is refunded.'],
  ['05', 'Claim', 'Winners claim their share of the pot. A round with only one side, or no signed price within 24H, refunds everyone.'],
] as const;

function HowItWorks() {
  return (
    <section aria-labelledby="how-rounds" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <h2 id="how-rounds" style={{ margin: 0, padding: '0 4px 6px', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)' }}>
        HOW A ROUND WORKS
      </h2>
      {STEPS.map(([n, title, body]) => (
        <div key={n} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 6, padding: '11px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
          <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', paddingTop: 2 }}>{n}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--dim)', marginTop: 2 }}>{body}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

function SidePill({ side }: { side: RoundSide }) {
  return (
    <span style={{ height: 26, display: 'flex', alignItems: 'center', padding: '0 11px', borderRadius: 9999, background: side === 'up' ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 14, whiteSpace: 'nowrap' }}>
      {sideName(side)}
    </span>
  );
}

function PositionCard(v: View) {
  const p = v.position;
  if (p.kind === 'none') return null;
  const claimButton = v.claimAmount > 0n && (
    <button onClick={v.openClaim} className="mk-press96" style={{ width: '100%', marginTop: 14, height: 56, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 18, boxShadow: 'var(--edge)' }}>
      {p.kind === 'refund' ? 'Claim refund' : 'Claim'} {usdcExact(v.claimAmount)} USDC
    </button>
  );
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0' }}>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>YOUR POSITION</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <SidePill side={p.side} />
        <span style={{ ...display, fontSize: 26, letterSpacing: '-0.02em' }}>{usdc2(p.amount)} USDC</span>
      </div>
      {p.kind === 'in' && (
        <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, fontSize: 12, marginTop: 10 }}>
          <span style={{ color: 'var(--dim)' }}>Est. payout if {sideName(p.side)} wins</span>
          <span style={{ fontWeight: 700 }}>{usdcFloor2(p.ifWins)} USDC</span>
        </div>
      )}
      {p.kind === 'won' && <div style={{ ...mono, fontSize: 12, marginTop: 10 }}>You won {usdcExact(p.payout)} USDC{p.claimed ? ', claimed.' : '.'}</div>}
      {p.kind === 'lost' && <div style={{ fontSize: 13, marginTop: 10, color: 'var(--dim)' }}>{sideName(p.side === 'up' ? 'down' : 'up')} won this one. Nothing to claim.</div>}
      {p.kind === 'refund' && (
        <div style={{ fontSize: 13, marginTop: 10, color: 'var(--dim)' }}>
          {p.claimed ? 'Refund claimed.' : p.marked ? 'Your full stake comes back, no fee.' : 'This round refunds everyone once it is marked refunded.'}
        </div>
      )}
      {v.creatorFeeDue !== null && <div style={{ ...mono, fontSize: 12, marginTop: 8 }}>Plus your creator fee: {usdcExact(v.creatorFeeDue)} USDC</div>}
      {claimButton}
    </div>
  );
}

function CreatorFee(v: View) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0' }}>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>YOUR CREATOR FEE</div>
      <div style={{ ...display, fontSize: 26, marginTop: 8 }}>{usdcExact(v.creatorFeeDue!)} USDC</div>
      <button onClick={v.openClaim} className="mk-press96" style={{ width: '100%', marginTop: 14, height: 56, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 18, boxShadow: 'var(--edge)' }}>
        Claim {usdcExact(v.creatorFeeDue!)} USDC
      </button>
    </div>
  );
}

function EnterForm(v: View) {
  const { side, setSide, sideLocked, amountText, setAmountText, amount, estimate, why, openEnter, balance, signedIn } = v;
  const ready = signedIn && amount !== null && !why;
  const button: React.CSSProperties = { height: 56, borderRadius: 9999, ...display, fontSize: 17, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' };
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, ...display, fontSize: 22 }}>{sideLocked ? 'Add to your prediction' : 'Make a prediction'}</h2>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>MIN 0.10 USDC</span>
      </div>
      <div role="group" aria-label="Side" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, borderRadius: 9999, background: 'var(--raise)' }}>
        {(['up', 'down'] as const).map((s) => {
          const on = s === side;
          const disabled = sideLocked && !on;
          return (
            <button
              key={s}
              onClick={() => setSide(s)}
              disabled={disabled}
              aria-pressed={on}
              title={disabled ? 'One wallet, one side: you are already on the other side.' : undefined}
              style={{ height: 44, borderRadius: 9999, background: on ? (s === 'up' ? 'var(--mako-signal)' : 'var(--mako-red)') : 'transparent', color: on ? '#000' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', ...display, fontSize: 16, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
            >
              {s === 'up' ? '↑ UP' : '↓ DOWN'}
            </button>
          );
        })}
      </div>
      <label style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '12px 16px', borderRadius: 12, background: 'var(--raise)' }}>
        <input
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          inputMode="decimal"
          aria-label="Amount in USDC"
          style={{ width: '100%', minWidth: 0, border: 0, outline: 0, background: 'transparent', color: 'var(--mako-canvas-fg)', ...display, fontSize: 40, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}
        />
        <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>USDC</span>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 6 }}>
        {CHIPS.map((c) => {
          const on = parseAmount(c) === amount;
          return (
            <button key={c} onClick={() => setAmountText(c)} aria-pressed={on} className="mk-press96" style={{ height: 34, borderRadius: 9999, background: on ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: on ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 11, fontWeight: 700 }}>
              {c}
            </button>
          );
        })}
      </div>
      <div style={{ ...mono, fontSize: 12 }}>
        {signedIn && (
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
            <span style={{ color: 'var(--dim)' }}>BALANCE</span>
            <span>{balance === null ? '…' : `${usdc2(balance)} USDC`}</span>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
          <span style={{ color: 'var(--dim)' }}>EST. PAYOUT IF {sideName(side)} WINS</span>
          <span style={{ fontWeight: 700 }}>{estimate === null ? '0.00' : usdcFloor2(estimate)} USDC</span>
        </div>
      </div>
      {!signedIn ? (
        <SignInLink className="mk-press96" style={{ ...button, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
          Sign in to predict
        </SignInLink>
      ) : (
        <button
          onClick={openEnter}
          disabled={!ready}
          className="mk-press96"
          style={{ ...button, background: ready ? (side === 'up' ? 'var(--mako-signal)' : 'var(--mako-red)') : 'var(--raise2)', color: ready ? '#000' : 'var(--dim)', boxShadow: ready ? 'var(--edge)' : 'none', cursor: ready ? 'pointer' : 'not-allowed' }}
        >
          {ready ? `${sideName(side)} · ${usdc2(amount!)} USDC` : "Can't place this prediction"}
        </button>
      )}
      {why && amount !== null && <div style={{ fontSize: 13, lineHeight: 1.45, padding: '10px 12px', borderRadius: 10, boxShadow: 'inset 0 0 0 1px var(--line)' }}>{why}</div>}
    </div>
  );
}
