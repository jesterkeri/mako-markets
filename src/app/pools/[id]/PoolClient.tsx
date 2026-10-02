'use client';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';

import { PoolCommentsDesktop, PoolCommentsMobile } from '@/components/comments/PoolComments';
import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { PoolShareSheet } from '@/components/PoolShareSheet';
import { SignInLink } from '@/components/signin/SignInLink';
import { computeMinLiquidityRatioBps, computePreviewPayout, computeResolvedClaim, isCreatorFeeForfeited } from '@/lib/bet';
import { explorerUrl } from '@/lib/chain';
import { makoContract, MarketType, type MarketWithId } from '@/lib/contract';
import { useMarket, useMarkets, useUsdcBalance } from '@/lib/hooks';
import { betBlocker, parseAmount, type BetLimits } from '@/lib/pool-bet-rules';
import { CAT_STYLE, catTitle, claimable, poolRow, STATE_COLOUR, stateLabel, usdc2, usdcExact, type PoolRow, type PoolState, type UserBet } from '@/lib/pool-list';
import { dayTime, poolClock, poolRules, poolSteps, RESOLUTION_GRACE_SEC, resultSteps } from '@/lib/pool-rules';
import { openSignIn } from '@/lib/sign-in-store';
import { useAddressNames } from '@/lib/use-address-names';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { useMakoLabels } from '@/lib/use-mako-labels';
import { usePoolTx } from '@/lib/use-pool-tx';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';

// One pool (9a): the question, where it is in its life, the odds, how it resolves, your position, and the bet form.
// Desktop is two columns; mobile is a stack with the bet panel pinned to the bottom (the shell hides its header and
// tab bar on this route). Every bet and claim goes through the confirm sheet (19a).

type Side = 'yes' | 'no';
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const CHIPS_DESKTOP = ['0.10', '1', '5', '10', '25', '50'];
const CHIPS_MOBILE = ['1', '5', '10', '25', '50'];

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

function walletOf(user: AuthedUser): { kind: 'mako' | 'external'; address: string } {
  return user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress };
}

/// The account's limits on this pool, read live; null until all five reads are in.
function useBetLimits(id: bigint, account: `0x${string}` | null) {
  const q = useReadContracts({
    contracts: [
      { ...makoContract, functionName: 'blocked' as const, args: [account ?? ZERO] as const },
      { ...makoContract, functionName: 'lastBetTime' as const, args: [id, account ?? ZERO] as const },
      { ...makoContract, functionName: 'maxBetPerWalletPerMarket' as const },
      { ...makoContract, functionName: 'maxWalletShareBps' as const },
      { ...makoContract, functionName: 'shareCapMinPool' as const },
    ],
    query: { enabled: account !== null, refetchInterval: 10_000 },
  });
  const d = q.data;
  const limits: BetLimits | null =
    d && d.every((r) => r.status === 'success')
      ? {
          blocked: d[0].result as boolean,
          lastBetTime: Number(d[1].result as bigint),
          maxPerWallet: d[2].result as bigint,
          maxShareBps: Number(d[3].result),
          shareCapMinPool: d[4].result as bigint,
        }
      : null;
  return { limits, refetch: q.refetch };
}

export function PoolClient({ id, initialSide }: { id: bigint; initialSide: Side | null }) {
  const { market, isLoading, isError, refetch } = useMarket(id);
  const now = useLiveNowSec();
  const { user } = useUser();
  const account = user ? accountAddress(user) : null;

  const betQ = useReadContract({ ...makoContract, functionName: 'getUserBet', args: [id, account ?? ZERO], query: { enabled: account !== null, refetchInterval: 10_000 } });
  const userBet: UserBet | undefined = useMemo(() => (betQ.data ? { yes: betQ.data[0], no: betQ.data[1], claimed: betQ.data[2] } : undefined), [betQ.data]);
  const { limits, refetch: refetchLimits } = useBetLimits(id, account);
  const balanceQ = useUsdcBalance(account ?? undefined);
  const balance = typeof balanceQ.data === 'bigint' ? balanceQ.data : null;
  const labelsQ = useMakoLabels(market?.mType === MarketType.MAKO ? id.toString() : null);
  const names = useAddressNames(useMemo(() => (market ? [market.creator] : []), [market]));
  const { markets } = useMarkets();

  const tx = usePoolTx(() => {
    void refetch();
    void betQ.refetch();
    void balanceQ.refetch();
    void refetchLimits();
  });

  const [side, setSide] = useState<Side>(initialSide ?? 'yes');
  const sidePicked = useRef(initialSide !== null);
  useEffect(() => {
    // With no side in the link, start on the side the account already holds.
    if (sidePicked.current || !userBet) return;
    if (userBet.yes > 0n !== userBet.no > 0n) setSide(userBet.no > 0n ? 'no' : 'yes');
    sidePicked.current = true;
  }, [userBet]);
  const [amountText, setAmountText] = useState('5');
  const [rulesOpen, setRulesOpen] = useState(false);
  /// The share sheet (15a), opened from the receipt's SHARE control.
  const [shareOpen, setShareOpen] = useState(false);
  const closeShare = useCallback(() => setShareOpen(false), []);
  /// The sheet's words, fixed when it opens: after a claim lands the refetch clears the claimable amount, and the
  /// sheet must still describe the action that was confirmed.
  const [sheetSpec, setSheetSpec] = useState<ConfirmSpec | null>(null);

  if (market && market.closeTime === 0n) notFound();

  if (!market || now === null) {
    const failed = isError && !isLoading;
    return <PoolStatus failed={failed} retry={() => void refetch()} />;
  }

  const row = poolRow(market, now, userBet);
  const labels = labelsQ.data ? { yes: labelsQ.data.label1, no: labelsQ.data.label2 } : { yes: 'YES', no: 'NO' };
  const by = market.mType === MarketType.MAKO ? 'Mako Market' : (names.get(market.creator.toLowerCase()) ?? formatAddress(market.creator));
  const amount = parseAmount(amountText);
  const mine = { yes: userBet?.yes ?? 0n, no: userBet?.no ?? 0n };
  const why =
    row.state !== 'open' ? null : amount === null ? 'Enter an amount in USDC, for example 5 or 2.50.' : user ? betBlocker({ m: market, nowSec: now, amount, balance, mine, limits }) : null;
  const estimate = amount && amount > 0n ? computePreviewPayout(market.totalYes, market.totalNo, amount, side === 'yes', BigInt(market.protocolFeeBpsSnapshot), BigInt(market.creatorFeeBpsSnapshot)) : null;
  const creatorStats = creatorStatsOf(markets, market);

  const claimAmount = claimable(row.position);
  const openBet = () => {
    if (amount === null || why || tx.tx) return;
    setSheetSpec(confirmSpec('bet', market, row, labels, amount, side, estimate, claimAmount));
    tx.open({ kind: 'bet', marketId: id, isYes: side === 'yes', amount });
  };
  const openClaim = () => {
    if (claimAmount === null || tx.tx) return;
    setSheetSpec(confirmSpec('claim', market, row, labels, amount, side, estimate, claimAmount));
    tx.open({ kind: 'claim', marketId: id });
  };

  const view: ViewProps = {
    market,
    row,
    now,
    labels,
    by,
    creatorStats,
    signedIn: user !== null,
    balance,
    side,
    setSide: (s) => {
      sidePicked.current = true;
      setSide(s);
    },
    amountText,
    setAmountText,
    amount,
    estimate,
    why,
    openBet,
    claimAmount,
    openClaim,
    lastClaimTx: tx.tx?.kind === 'claim' && tx.phase.step === 'done' ? tx.phase.txHash : undefined,
    rulesOpen,
    setRulesOpen,
    openShare: () => setShareOpen(true),
  };

  const spec = tx.tx ? sheetSpec : null;

  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <PoolDesktop {...view} />
      </div>
      <div className="mk-mob mk-m">
        <PoolMobile {...view} />
      </div>
      {shareOpen && <PoolShareSheet market={market} now={now} labels={labels} by={by} onClose={closeShare} />}
      {spec && user && (
        <ConfirmSheet spec={spec} phase={tx.phase} wallet={walletOf(user)} onConfirm={tx.confirm} onCancel={tx.close} onRetry={tx.retry} onClose={tx.close} />
      )}
    </>
  );
}

/// The creator's pools on chain and the share that got money on both sides: the design's creator card, from real
/// data only (no rounds yet, so no round count).
function creatorStatsOf(markets: readonly MarketWithId[], m: MarketWithId): { pools: number; bothSides: number } | null {
  if (m.mType === MarketType.MAKO || markets.length === 0) return null;
  const mineOnly = markets.filter((x) => x.creator.toLowerCase() === m.creator.toLowerCase());
  if (mineOnly.length === 0) return null;
  const both = mineOnly.filter((x) => x.totalYes > 0n && x.totalNo > 0n).length;
  return { pools: mineOnly.length, bothSides: Math.round((both * 100) / mineOnly.length) };
}

function confirmSpec(
  kind: 'bet' | 'claim',
  m: MarketWithId,
  row: PoolRow,
  labels: { yes: string; no: string },
  amount: bigint | null,
  side: Side,
  estimate: bigint | null,
  claimAmount: bigint | null,
): ConfirmSpec {
  if (kind === 'claim') {
    const amt = usdcExact(claimAmount ?? 0n);
    const refund = row.state === 'refunded';
    return {
      glyph: '$',
      glyphColor: 'var(--mako-teal)',
      title: `${refund ? 'Claim refund' : 'Claim'} · ${amt} USDC`,
      confirmLabel: `Confirm · ${amt} USDC`,
      pendingTitle: refund ? 'Claiming your refund' : 'Claiming your winnings',
      rows: [
        { label: 'Pool', value: m.question },
        { label: refund ? 'Refund' : 'Payout', value: `${amt} USDC` },
      ],
      note: refund ? 'A refund returns your full stake, with no fee.' : 'Fees were taken when the pool settled; the claim pays out the rest.',
      doneTitle: refund ? 'Refund claimed' : 'Claimed',
      doneBody: `${amt} USDC is in your balance.`,
      doneSecondary: { label: 'View in Me', href: '/me' },
    };
  }
  const isYes = side === 'yes';
  const name = isYes ? labels.yes : labels.no;
  const amt = usdcExact(amount ?? 0n);
  return {
    glyph: isYes ? 'Y' : 'N',
    glyphColor: isYes ? 'var(--mako-signal)' : 'var(--mako-red)',
    title: `Bet ${name} · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: 'Placing your bet',
    rows: [
      { label: 'Pool', value: m.question },
      { label: 'Side', value: name, tone: isYes ? 'up' : 'no' },
      { label: 'Stake', value: `${amt} USDC` },
      { label: `Est. payout if ${name} wins`, value: estimate === null ? 'Unknown' : `${usdc2(estimate)} USDC` },
    ],
    note: 'The payout is an estimate until betting closes.',
    doneTitle: 'Bet placed',
    doneBody: `${amt} USDC on ${name}.`,
    doneSecondary: { label: 'View in Me', href: '/me' },
  };
}

type ViewProps = {
  market: MarketWithId;
  row: PoolRow;
  now: number;
  labels: { yes: string; no: string };
  by: string;
  creatorStats: { pools: number; bothSides: number } | null;
  signedIn: boolean;
  balance: bigint | null;
  side: Side;
  setSide: (s: Side) => void;
  amountText: string;
  setAmountText: (s: string) => void;
  amount: bigint | null;
  estimate: bigint | null;
  why: string | null;
  openBet: () => void;
  claimAmount: bigint | null;
  openClaim: () => void;
  lastClaimTx: string | undefined;
  rulesOpen: boolean;
  setRulesOpen: (b: boolean) => void;
  openShare: () => void;
};

/// The fee sentence, from this pool's own fee snapshot.
function feeNote(m: MarketWithId): string {
  const p = m.protocolFeeBpsSnapshot / 100;
  const c = m.creatorFeeBpsSnapshot / 100;
  if (m.creatorFeeBpsSnapshot === 0) return `Mako Market takes ${p}% of the pool, only if the pool settles YES or NO. The estimate changes until betting closes.`;
  const ratio = Number(computeMinLiquidityRatioBps(BigInt(m.creatorFeeBpsSnapshot))) / 100;
  return `Mako Market takes ${p}% of the pool and the creator ${c}%, only if the pool settles YES or NO. When the smaller side is under ${ratio}% of the larger, the creator's share goes to the winners. The estimate changes until betting closes.`;
}

/// The receipt rows for a pool settled YES or NO.
function receipt(m: MarketWithId, row: PoolRow, labels: { yes: string; no: string }): { k: string; v: string }[] {
  const total = m.totalYes + m.totalNo;
  const protocol = (total * BigInt(m.protocolFeeBpsSnapshot)) / 10_000n;
  const waived = isCreatorFeeForfeited(m.totalYes, m.totalNo, BigInt(m.creatorFeeBpsSnapshot));
  const creator = waived ? 0n : (total * BigInt(m.creatorFeeBpsSnapshot)) / 10_000n;
  const rows = [
    { k: 'Outcome', v: row.state === 'yes_won' ? `${labels.yes} won` : `${labels.no} won` },
    { k: 'Pool', v: `${usdc2(total)} USDC` },
    { k: 'Split', v: `${usdc2(m.totalYes)} ${labels.yes} · ${usdc2(m.totalNo)} ${labels.no}` },
    {
      k: 'Fees',
      v:
        m.creatorFeeBpsSnapshot === 0
          ? `${usdc2(protocol)} USDC to Mako Market (${m.protocolFeeBpsSnapshot / 100}%)`
          : waived
            ? `${usdc2(protocol)} USDC to Mako Market (${m.protocolFeeBpsSnapshot / 100}%). Creator fee waived: the smaller side was too small.`
            : `${usdc2(protocol)} USDC to Mako Market (${m.protocolFeeBpsSnapshot / 100}%) + ${usdc2(creator)} USDC to the creator (${m.creatorFeeBpsSnapshot / 100}%)`,
    },
  ];
  const p = row.position;
  if (p?.kind === 'won') rows.push({ k: 'Your payout', v: `${usdc2(p.amount)} USDC` });
  if (p?.kind === 'lost') rows.push({ k: 'Your payout', v: '0.00 USDC' });
  return rows;
}

function perOne(n: number | null): string | null {
  return n === null ? null : `${n.toFixed(2)}x`;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading and error

function PoolStatus({ failed, retry }: { failed: boolean; retry: () => void }) {
  const bar = (w: string | number, h: number): React.CSSProperties => ({ width: w, height: h, borderRadius: 9999, background: 'color-mix(in srgb, var(--mako-canvas-fg) 16%, transparent)' });
  return (
    <div className="mk-desk-frame" style={{ padding: '32px 24px' }}>
      {failed ? (
        <div role="alert" style={{ padding: '40px 4px', textAlign: 'center' }}>
          <div style={{ ...display, fontSize: 28 }}>Can’t load this pool right now</div>
          <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 8 }}>Mako Market couldn’t read it from Monad. Your bets are safe on-chain.</div>
          <button onClick={retry} className="mk-press96" style={{ marginTop: 18, height: 48, padding: '0 22px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 16 }}>
            Try again
          </button>
        </div>
      ) : (
        <div aria-label="Loading the pool" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={bar(120, 12)} />
          <div style={bar('70%', 44)} />
          <div style={bar('45%', 14)} />
          <div style={bar('100%', 6)} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop

function PoolDesktop(v: ViewProps) {
  const { market: m, row, now, by } = v;
  const cat = CAT_STYLE[row.cat];
  const clock = poolClock(m, row.state, now);
  const steps = poolSteps(m, row.state);
  const open = row.state === 'open';
  const settled = row.state === 'yes_won' || row.state === 'no_won';
  return (
    <div style={{ paddingBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 4px 0' }}>
        <Link href="/pools" style={{ ...mono, fontSize: 12, color: 'var(--dim)', textDecoration: 'none' }}>
          ← POOLS
        </Link>
        {/* Not drawn by the design on this page (it shares from the settled receipt only); added so an open pool can be
            shared (Joshua, 2026-10-02). */}
        <button onClick={v.openShare} aria-haspopup="dialog" className="mk-press96" style={{ height: 32, padding: '0 14px', borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)', ...mono, fontSize: 11, fontWeight: 700 }}>
          SHARE ↗
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 32, padding: '10px 4px 22px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ height: 26, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 9999, background: STATE_COLOUR[row.state], color: '#000', boxShadow: 'var(--edge)', fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
              {stateLabel(row.state)}
            </span>
            <span aria-hidden="true" style={{ flex: 'none', width: 26, height: 26, borderRadius: 9999, background: cat.bg, color: cat.fg, boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...mono, fontSize: 9, fontWeight: 700 }}>
              {cat.abbr}
            </span>
            <span style={{ ...mono, fontSize: 12, color: 'var(--dim)' }}>
              {row.cat} · {row.bettors} {row.bettors === 1 ? 'BETTOR' : 'BETTORS'}
            </span>
          </div>
          <h1 style={{ margin: '14px 0 0', ...display, fontSize: 52, lineHeight: 1.02, letterSpacing: '-0.035em', maxWidth: 720, textWrap: 'balance' }}>{m.question}</h1>
          <div style={{ fontSize: 15, color: 'var(--dim)', marginTop: 10 }}>
            {catTitle(row.cat)} · betting closes {dayTime(Number(m.bettingCloseTime))}. Hosted by <span style={{ color: 'var(--mako-canvas-fg)', fontWeight: 700 }}>{by}</span>
          </div>
        </div>
        <div style={{ flex: 'none', textAlign: 'right' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--dim)' }}>{clock.label}</div>
          <div style={{ ...display, fontSize: 84, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', marginTop: 4, whiteSpace: 'nowrap' }}>{clock.value}</div>
          <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 6, maxWidth: 360 }}>{clock.sub}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {steps.map((t) => (
          <div key={t.l} style={{ flex: t.flex, minWidth: 0 }}>
            <div style={{ height: 6, borderRadius: 9999, background: t.done ? 'var(--mako-canvas-fg)' : t.current ? STATE_COLOUR[row.state] : 'var(--raise2)' }} />
            <div style={{ ...mono, fontSize: 11, marginTop: 8, color: t.done || t.current ? 'var(--mako-canvas-fg)' : 'var(--dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <span style={{ fontWeight: 700 }}>{t.l}</span> · {t.t}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 28, marginTop: 26 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
          <Odds {...v} />
          {settled && <Receipt {...v} />}
          {row.state === 'refunded' && (
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ ...display, fontSize: 24, letterSpacing: '-0.02em', padding: '0 4px' }}>Everyone is refunded</span>
              <div style={{ fontSize: 16, lineHeight: 1.5, padding: '0 4px' }}>This pool was refunded, so everyone claims their full stake back. Refunds carry no fee.</div>
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
            <h2 style={{ margin: 0, ...display, fontSize: 24, letterSpacing: '-0.02em', padding: '0 4px' }}>How this pool resolves</h2>
            <div style={{ marginTop: 8 }}>
              {poolRules(m).map((r) => (
                <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: 16, padding: '11px 4px', boxShadow: 'inset 0 -1px 0 var(--line)', fontSize: 14, lineHeight: 1.45 }}>
                  <span style={{ ...mono, fontSize: 12, fontWeight: 700, color: r.k === 'YES' ? 'var(--up-text)' : r.k === 'NO' || r.k === 'WARNING' ? 'var(--mako-red)' : 'var(--mako-canvas-fg)' }}>{r.k}</span>
                  <span>{r.v}</span>
                </div>
              ))}
            </div>
          </div>
          <PoolCommentsDesktop marketId={m.id.toString()} onSignIn={openSignIn} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {row.position && <PositionDesktop {...v} />}
          {open && <BetFormDesktop {...v} />}
          {(row.state === 'betting_closed' || row.state === 'resolving') && (
            <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0', fontSize: 14, lineHeight: 1.5, color: 'var(--dim)' }}>{closedNote(row.state, m, v.now)}</div>
          )}
          {!open && <HowResultsWork market={m} />}
          <CreatorCard {...v} />
        </div>
      </div>
    </div>
  );
}

/// 18a's "How results work", for every pool past its open phase: what happens from betting close to the claim.
function resultStepsOf(m: MarketWithId) {
  return resultSteps(m, Number(computeMinLiquidityRatioBps(BigInt(m.creatorFeeBpsSnapshot))));
}

function HowResultsWork({ market: m }: { market: MarketWithId }) {
  return (
    <section aria-labelledby="how-results" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <h2 id="how-results" style={{ margin: 0, padding: '0 4px 6px', ...mono, fontSize: 11, fontWeight: 700, color: 'var(--dim)' }}>
        HOW RESULTS WORK
      </h2>
      {resultStepsOf(m).map((s) => (
        <div key={s.n} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 6, padding: '11px 4px', boxShadow: 'inset 0 1px 0 var(--line)' }}>
          <span style={{ ...mono, fontSize: 11, color: 'var(--dim)', paddingTop: 2 }}>{s.n}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{s.title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--dim)', marginTop: 2 }}>{s.body}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

function closedNote(state: PoolState, m: MarketWithId, now: number): string {
  const close = dayTime(Number(m.closeTime));
  if (state === 'betting_closed') return `Betting closed ${dayTime(Number(m.bettingCloseTime))}. Mako Market settles the result after ${close}.`;
  return now >= Number(m.closeTime) + RESOLUTION_GRACE_SEC
    ? `It wasn't settled within 24H of ${close}, so it can now be marked refunded. Then everyone claims their stake back, no fee.`
    : `Waiting for the result. If it isn't settled within 24H of ${close}, anyone can mark the pool refunded.`;
}

function Odds({ market: m, row, labels }: ViewProps) {
  const open = row.state === 'open';
  const yesWon = row.state === 'yes_won';
  const noWon = row.state === 'no_won';
  const big = (s: string | null) =>
    s === null ? (
      <span style={{ ...display, fontSize: 22, color: 'var(--dim)' }}>No stake yet</span>
    ) : (
      <span style={{ ...display, fontSize: 56, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{s}</span>
    );
  const won = (bg: string) => <span style={{ ...mono, fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 9999, background: bg, color: '#000', boxShadow: 'var(--edge)' }}>WON</span>;
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: '0 4px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ ...display, fontSize: 22 }}>{labels.yes}</span>
            {yesWon && won('var(--mako-teal)')}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            {big(perOne(row.yesPays))}
            {row.yesPays !== null && <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>PER 1 USDC</span>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: 'row-reverse' }}>
            <span style={{ ...display, fontSize: 22 }}>{labels.no}</span>
            {noWon && won('var(--mako-red)')}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexDirection: 'row-reverse' }}>
            {big(perOne(row.noPays))}
            {row.noPays !== null && <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>PER 1 USDC</span>}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', height: 34, borderRadius: 9999, overflow: 'hidden', margin: '14px 4px 0', border: '1.5px solid var(--edge-c)' }}>
        <div style={{ width: `${row.yesPct}%`, transition: 'width 700ms cubic-bezier(0.23,1,0.32,1)', background: 'var(--mako-signal)', color: '#000', display: 'flex', alignItems: 'center', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{row.yesPct}%</div>
        <div style={{ flex: 1, background: 'var(--mako-red)', borderLeft: '1.5px solid var(--edge-c)', color: '#000', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 14px', ...mono, fontSize: 13, fontWeight: 700, minWidth: 60 }}>{row.noPct}%</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 4px 0', ...mono, fontSize: 13 }}>
        <span>
          <span style={{ fontWeight: 700 }}>{usdc2(m.totalYes)} USDC</span> <span style={{ color: 'var(--dim)' }}>· {m.yesBettorCount} {m.yesBettorCount === 1 ? 'bettor' : 'bettors'}</span>
        </span>
        <span>
          <span style={{ color: 'var(--dim)' }}>{m.noBettorCount} {m.noBettorCount === 1 ? 'bettor' : 'bettors'} ·</span> <span style={{ fontWeight: 700 }}>{usdc2(m.totalNo)} USDC</span>
        </span>
      </div>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)', padding: '10px 4px 0' }}>
        {open ? 'Estimates change until betting closes.' : 'Final odds, set when betting closed.'} Winners split the pool in proportion to their stake.
      </div>
    </div>
  );
}

function Receipt({ market: m, row, labels, openShare }: ViewProps) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <h2 style={{ margin: 0, ...display, fontSize: 24, letterSpacing: '-0.02em' }}>Result receipt</h2>
        <button onClick={openShare} aria-haspopup="dialog" style={{ ...mono, fontSize: 11, fontWeight: 700 }}>
          SHARE ↗
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        {receipt(m, row, labels).map((r) => (
          <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '170px minmax(0,1fr)', gap: 16, alignItems: 'center', padding: '10px 4px', boxShadow: 'inset 0 -1px 0 var(--line)', ...mono, fontSize: 13 }}>
            <span style={{ color: 'var(--dim)' }}>{r.k}</span>
            <span style={{ fontWeight: 700 }}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/// The account's stake per side, with what each would pay if it wins now (or what it paid).
function positionLines(v: ViewProps): { side: Side; stake: bigint }[] {
  const p = v.row.position;
  if (!p) return [];
  if (p.kind === 'staked') return (['yes', 'no'] as const).map((s) => ({ side: s, stake: s === 'yes' ? p.yes : p.no })).filter((x) => x.stake > 0n);
  return [];
}

function estPayoutIf(m: MarketWithId, side: Side, stake: bigint): bigint {
  const win = side === 'yes' ? m.totalYes : m.totalNo;
  const lose = side === 'yes' ? m.totalNo : m.totalYes;
  return computeResolvedClaim(win, lose, stake, BigInt(m.protocolFeeBpsSnapshot), BigInt(m.creatorFeeBpsSnapshot));
}

function SidePill({ side, labels, small }: { side: Side; labels: { yes: string; no: string }; small?: boolean }) {
  return (
    <span style={{ height: small ? 22 : 26, display: 'flex', alignItems: 'center', padding: '0 11px', borderRadius: 9999, background: side === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: small ? 12 : 14, whiteSpace: 'nowrap' }}>
      {side === 'yes' ? labels.yes : labels.no}
    </span>
  );
}

function PositionDesktop(v: ViewProps) {
  const { market: m, row, labels, claimAmount, openClaim, lastClaimTx } = v;
  const p = row.position!;
  const lines = positionLines(v);
  const winner: Side | null = row.state === 'yes_won' ? 'yes' : row.state === 'no_won' ? 'no' : null;
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0' }}>
      <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>YOUR POSITION</div>
      {p.kind === 'staked' &&
        lines.map((l) => (
          <div key={l.side} style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SidePill side={l.side} labels={labels} />
              <span style={{ ...display, fontSize: 26, letterSpacing: '-0.02em' }}>{usdc2(l.stake)} USDC</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', ...mono, fontSize: 12, marginTop: 10 }}>
              <span style={{ color: 'var(--dim)' }}>Est. payout if {l.side === 'yes' ? labels.yes : labels.no} wins</span>
              <span style={{ fontWeight: 700 }}>{usdc2(estPayoutIf(m, l.side, l.stake))} USDC</span>
            </div>
          </div>
        ))}
      {(p.kind === 'won' || p.kind === 'refund') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            {p.kind === 'won' && winner && <SidePill side={winner} labels={labels} />}
            <span style={{ ...display, fontSize: 26, letterSpacing: '-0.02em' }}>{usdc2(p.amount)} USDC</span>
          </div>
          <div style={{ ...mono, fontSize: 12, marginTop: 10, color: 'var(--dim)' }}>{p.kind === 'won' ? 'Your payout' : 'Your refund: your full stake, no fee'}</div>
          {claimAmount !== null && (
            <button onClick={openClaim} className="mk-press96" style={{ width: '100%', marginTop: 14, height: 56, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', ...display, fontSize: 18, boxShadow: 'var(--edge)' }}>
              {p.kind === 'refund' ? 'Claim refund' : 'Claim'} {usdc2(claimAmount)} USDC
            </button>
          )}
          {p.claimed && (
            <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 12, background: 'var(--raise)', boxShadow: 'var(--edge)', ...mono, fontSize: 12 }}>
              <div style={{ fontWeight: 700 }}>✓ Claimed {usdc2(p.amount)} USDC</div>
              <div style={{ color: 'var(--dim)', marginTop: 4 }}>
                In your balance
                {lastClaimTx && (
                  <>
                    {' · '}
                    <a href={explorerUrl('tx', lastClaimTx)} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
                      tx {formatAddress(lastClaimTx)} ↗
                    </a>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {p.kind === 'lost' && winner && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--dim)' }}>
          {winner === 'yes' ? labels.yes : labels.no} won this one. Nothing to claim ({usdc2(p.amount)} USDC staked on {winner === 'yes' ? labels.no : labels.yes}).
        </div>
      )}
    </div>
  );
}

function BetFormDesktop(v: ViewProps) {
  const { market: m, row, labels, side, setSide, amountText, setAmountText, amount, estimate, why, openBet, balance, signedIn } = v;
  const name = side === 'yes' ? labels.yes : labels.no;
  const hasStake = row.position?.kind === 'staked';
  const button: React.CSSProperties = { height: 56, borderRadius: 9999, ...display, fontSize: 17, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' };
  const ready = signedIn && amount !== null && !why;
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={{ margin: 0, ...display, fontSize: 22 }}>{hasStake ? 'Add to your bet' : 'Place a bet'}</h2>
        <span style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>MIN 0.10 USDC</span>
      </div>
      <SideToggle side={side} setSide={setSide} labels={labels} height={42} fontSize={16} />
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
        {CHIPS_DESKTOP.map((c) => {
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
          <span style={{ color: 'var(--dim)' }}>EST. PAYOUT IF {name.toUpperCase()} WINS</span>
          <span style={{ fontWeight: 700 }}>{estimate === null ? '0.00' : usdc2(estimate)} USDC</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
          <span style={{ color: 'var(--dim)' }}>PROFIT</span>
          <span style={{ fontWeight: 700 }}>{estimate === null || amount === null ? '0.00' : `${estimate >= amount ? '+' : '−'}${usdc2(estimate >= amount ? estimate - amount : amount - estimate)}`} USDC</span>
        </div>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--dim)' }}>{feeNote(m)}</div>
      {!signedIn ? (
        <SignInLink className="mk-press96" style={{ ...button, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
          Sign in to bet
        </SignInLink>
      ) : (
        <button
          onClick={openBet}
          disabled={!ready}
          className="mk-press96"
          style={{ ...button, background: ready ? (side === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)') : 'var(--raise2)', color: ready ? '#000' : 'var(--dim)', boxShadow: ready ? 'var(--edge)' : 'none', cursor: ready ? 'pointer' : 'not-allowed' }}
        >
          {ready ? `Bet ${usdc2(amount!)} USDC on ${name}` : "Can't place this bet"}
        </button>
      )}
      {why && <div style={{ fontSize: 13, lineHeight: 1.45, padding: '10px 12px', borderRadius: 10, boxShadow: 'inset 0 0 0 1px var(--line)' }}>{why}</div>}
    </div>
  );
}

function SideToggle({ side, setSide, labels, height, fontSize, background = 'var(--raise)' }: { side: Side; setSide: (s: Side) => void; labels: { yes: string; no: string }; height: number; fontSize: number; background?: string }) {
  return (
    <div role="group" aria-label="Side" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, borderRadius: 9999, background }}>
      {(['yes', 'no'] as const).map((s) => {
        const on = s === side;
        return (
          <button
            key={s}
            onClick={() => setSide(s)}
            aria-pressed={on}
            style={{ height, borderRadius: 9999, background: on ? (s === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)') : 'transparent', color: on ? '#000' : 'var(--mako-canvas-fg)', boxShadow: on ? 'var(--edge)' : 'none', ...display, fontSize, transition: 'background-color 200ms ease', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 8px' }}
          >
            {s === 'yes' ? labels.yes : labels.no}
          </button>
        );
      })}
    </div>
  );
}

function CreatorCard({ by, creatorStats, market: m }: ViewProps) {
  const initial = [...by][0]?.toUpperCase() ?? '?';
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 9999, background: 'var(--mako-teal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 15 }}>
        {initial}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{by}</div>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>
          {m.mType === MarketType.MAKO
            ? 'House pool'
            : creatorStats
              ? `${creatorStats.pools} ${creatorStats.pools === 1 ? 'pool' : 'pools'} · ${creatorStats.bothSides}% got bets on both sides`
              : 'Creator'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Mobile

function PoolMobile(v: ViewProps) {
  const { market: m, row, now, labels, by, rulesOpen, setRulesOpen, balance, signedIn } = v;
  const cat = CAT_STYLE[row.cat];
  const clock = poolClock(m, row.state, now);
  const steps = poolSteps(m, row.state);
  const settled = row.state === 'yes_won' || row.state === 'no_won';
  const lines = positionLines(v);
  const roundBtn: React.CSSProperties = { flex: 'none', width: 44, height: 44, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--mako-canvas-fg)' };
  return (
    <div>
      <header style={{ height: 68, display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 8, padding: '0 16px' }}>
        <Link href="/pools" aria-label="Back to pools" className="m3-press" style={roundBtn}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14.5 17.5L9 12l5.5-5.5" />
          </svg>
        </Link>
        <span style={{ textAlign: 'center', fontSize: 16, fontWeight: 700 }}>Pool</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={v.openShare} aria-label="Share pool" aria-haspopup="dialog" className="m3-press" style={roundBtn}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 15V4M8 8l4-4 4 4M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" />
            </svg>
          </button>
          {signedIn ? (
            <span style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 14px', borderRadius: 9999, background: 'var(--raise)', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{balance === null ? '…' : `${usdc2(balance)} USDC`}</span>
          ) : (
            <SignInLink style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 16px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 15, fontWeight: 800, textDecoration: 'none' }}>
              Sign in
            </SignInLink>
          )}
        </span>
      </header>

      <div style={{ padding: '4px 12px 300px' }}>
        <div style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ height: 26, display: 'flex', alignItems: 'center', padding: '0 11px', borderRadius: 9999, background: STATE_COLOUR[row.state], color: '#000', boxShadow: 'var(--edge)', fontSize: 11, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{stateLabel(row.state)}</span>
            <span style={{ height: 26, display: 'flex', alignItems: 'center', gap: 6, padding: '0 11px 0 3px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 12, fontWeight: 800 }}>
              <span aria-hidden="true" style={{ width: 20, height: 20, borderRadius: 9999, background: cat.bg, color: cat.fg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8 }}>
                {cat.abbr}
              </span>
              {catTitle(row.cat)}
            </span>
          </div>
          <h1 style={{ margin: '14px 0 0', ...display, fontSize: 28, lineHeight: 1.08, letterSpacing: '-0.025em' }}>{m.question}</h1>
          <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.65, marginTop: 8 }}>
            Closes {dayTime(Number(m.bettingCloseTime))} · Hosted by {by} · {row.bettors} {row.bettors === 1 ? 'bettor' : 'bettors'}
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 18, gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.65 }}>{clock.label}</div>
              <div style={{ ...display, fontSize: 44, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{clock.value}</div>
            </div>
            <button onClick={() => setRulesOpen(true)} aria-expanded={rulesOpen} className="m3-press" style={{ height: 44, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 0 6px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 14, fontWeight: 700 }}>
              <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 9999, background: 'var(--m3-inv-fg)', color: 'var(--m3-inv)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 11.2v5M12 7.8v.1" />
                </svg>
              </span>
              Rules
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 14 }}>
            {steps.map((t) => (
              <div key={t.l} style={{ flex: 1, height: 6, borderRadius: 9999, background: t.done ? 'var(--m3-inv-fg)' : t.current ? STATE_COLOUR[row.state] : 'var(--m3-inv-2)' }} />
            ))}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          {(['yes', 'no'] as const).map((s) => {
            const yes = s === 'yes';
            const pays = perOne(yes ? row.yesPays : row.noPays);
            const won = (yes && row.state === 'yes_won') || (!yes && row.state === 'no_won');
            return (
              <div key={s} style={{ borderRadius: yes ? '28px 28px 28px 10px' : '28px 28px 10px 28px', background: yes ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', padding: 16, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <span style={{ ...display, fontSize: 24, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{yes ? labels.yes : labels.no}</span>
                  {won && <span style={{ height: 24, display: 'flex', alignItems: 'center', padding: '0 9px', borderRadius: 9999, background: '#000', color: yes ? 'var(--mako-signal)' : 'var(--mako-red)', fontSize: 11, fontWeight: 800 }}>WON</span>}
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.65, marginTop: 14 }}>Pays per 1</div>
                <div style={{ ...display, fontSize: pays ? 32 : 18, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>{pays ?? 'No stake yet'}</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>
                  {usdc2(yes ? m.totalYes : m.totalNo)} · {yes ? m.yesBettorCount : m.noBettorCount} {(yes ? m.yesBettorCount : m.noBettorCount) === 1 ? 'bettor' : 'bettors'}
                </div>
              </div>
            );
          })}
        </div>

        {lines.map((l) => (
          <div key={l.side} style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 24, background: 'var(--raise)', padding: '14px 16px', marginTop: 10 }}>
            <span style={{ width: 40, height: 40, borderRadius: 9999, background: l.side === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800 }}>{l.side === 'yes' ? 'YES' : 'NO'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--dim)' }}>Your position</div>
              <div style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{usdc2(l.stake)} USDC</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, color: 'var(--dim)' }}>Est. payout if {l.side === 'yes' ? labels.yes : labels.no} wins</div>
              <div style={{ fontSize: 16, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{usdc2(estPayoutIf(m, l.side, l.stake))} USDC</div>
            </div>
          </div>
        ))}

        {settled && (
          <div style={{ marginTop: 10, borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '16px 18px 10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
              <span style={{ ...display, fontSize: 20 }}>Result receipt</span>
              <button onClick={v.openShare} aria-haspopup="dialog" className="m3-press" style={{ flex: 'none', height: 36, padding: '0 14px', borderRadius: 9999, background: 'var(--m3-inv-2)', fontSize: 14, fontWeight: 800 }}>
                Share
              </button>
            </div>
            {receipt(m, row, labels).map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, padding: '10px 0', boxShadow: 'inset 0 -1px 0 var(--m3-inv-2)', fontSize: 13 }}>
                <span style={{ flex: 'none', fontWeight: 600, opacity: 0.65 }}>{r.k}</span>
                <span style={{ fontWeight: 700, textAlign: 'right' }}>{r.v}</span>
              </div>
            ))}
          </div>
        )}
        {row.state === 'refunded' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', borderRadius: 24, background: 'var(--mako-cyan)', color: '#000', boxShadow: 'var(--edge)', padding: 16, marginTop: 10 }}>
            <span aria-hidden="true" style={{ flex: 'none', width: 40, height: 40, borderRadius: 9999, background: '#000', color: 'var(--mako-cyan)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800 }}>
              ↺
            </span>
            <div style={{ fontSize: 14, lineHeight: 1.4, fontWeight: 600 }}>This pool was refunded, so everyone claims their full stake back. No fee.</div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, borderRadius: 24, background: 'var(--raise)', padding: '14px 16px', marginTop: 10 }}>
          <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--mako-teal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...display, fontSize: 16 }}>
            {[...by][0]?.toUpperCase() ?? '?'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{by}</div>
            <div style={{ fontSize: 13, color: 'var(--dim)' }}>
              {m.mType === MarketType.MAKO ? 'House pool' : v.creatorStats ? `${v.creatorStats.pools} ${v.creatorStats.pools === 1 ? 'pool' : 'pools'} · ${v.creatorStats.bothSides}% got bets on both sides` : 'Creator'}
            </div>
          </div>
        </div>

        <PoolCommentsMobile marketId={m.id.toString()} onSignIn={openSignIn} />
      </div>

      {rulesOpen && (
        <>
          <div onClick={() => setRulesOpen(false)} className="mk-scrim" style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.5)' }} />
          <div role="dialog" aria-label="How this pool resolves" className="mk-pop" style={{ position: 'fixed', top: 120, left: 12, right: 12, zIndex: 51, maxHeight: 'calc(100dvh - 160px)', overflow: 'auto', borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge), 0 24px 60px rgba(0,0,0,0.5)', padding: '20px 20px 16px', transformOrigin: '80% 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ ...display, fontSize: 22 }}>How it resolves</span>
              <button onClick={() => setRulesOpen(false)} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--m3-inv-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 7l10 10M17 7L7 17" />
                </svg>
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              {poolRules(m).map((r) => (
                <div key={r.k} style={{ display: 'grid', gridTemplateColumns: '72px minmax(0,1fr)', gap: 12, padding: '11px 0', boxShadow: 'inset 0 -1px 0 var(--m3-inv-2)', fontSize: 14, lineHeight: 1.45 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, opacity: 0.7 }}>{r.k}</span>
                  <span>{r.v}</span>
                </div>
              ))}
            </div>
            {row.state !== 'open' && (
              <div style={{ marginTop: 16 }}>
                <div style={{ ...display, fontSize: 18 }}>How results work</div>
                {resultStepsOf(m).map((s) => (
                  <div key={s.n} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 8, padding: '11px 0', boxShadow: 'inset 0 -1px 0 var(--m3-inv-2)' }}>
                    <span style={{ fontSize: 12, fontWeight: 800, opacity: 0.7, paddingTop: 2 }}>{s.n}</span>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 800 }}>{s.title}</div>
                      <div style={{ fontSize: 13, lineHeight: 1.45, opacity: 0.75, marginTop: 2 }}>{s.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => setRulesOpen(false)} className="m3-press" style={{ width: '100%', height: 52, marginTop: 14, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800 }}>
              Got it
            </button>
          </div>
        </>
      )}

      <MobileBottom {...v} />
    </div>
  );
}

function MobileBottom(v: ViewProps) {
  const { market: m, row, labels, side, setSide, amountText, setAmountText, amount, estimate, why, openBet, claimAmount, openClaim, signedIn } = v;
  const name = side === 'yes' ? labels.yes : labels.no;
  const p = row.position;
  const winner: Side | null = row.state === 'yes_won' ? 'yes' : row.state === 'no_won' ? 'no' : null;
  const ready = signedIn && amount !== null && !why;
  const big: React.CSSProperties = { height: 56, borderRadius: 9999, fontSize: 17, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' };
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30, borderRadius: '28px 28px 0 0', background: 'var(--raise)', boxShadow: '0 -10px 30px rgba(0,0,0,0.25)', padding: '10px 16px calc(24px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div aria-hidden="true" style={{ width: 36, height: 4, borderRadius: 9999, background: 'var(--m3-outline)', alignSelf: 'center' }} />
      {row.state === 'open' && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ width: 150, flex: 'none' }}>
              <SideToggle side={side} setSide={setSide} labels={labels} height={38} fontSize={14} background="var(--mako-canvas)" />
            </div>
            <input
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              inputMode="decimal"
              aria-label="Amount in USDC"
              style={{ marginLeft: 'auto', width: 0, flex: 1, textAlign: 'right', border: 0, outline: 0, background: 'transparent', color: 'var(--mako-canvas-fg)', ...display, fontSize: 30, fontVariantNumeric: 'tabular-nums' }}
            />
            <span style={{ fontSize: 13, color: 'var(--dim)' }}>USDC</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6 }}>
            {CHIPS_MOBILE.map((c) => {
              const on = parseAmount(c) === amount;
              return (
                <button key={c} onClick={() => setAmountText(c)} aria-pressed={on} className="m3-press" style={{ height: 38, borderRadius: 9999, background: on ? 'var(--m3-inv)' : 'var(--mako-canvas)', color: on ? 'var(--m3-inv-fg)' : 'var(--mako-canvas-fg)', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {c}
                </button>
              );
            })}
          </div>
          {why && <div style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--dim)' }}>{why}</div>}
          {!signedIn ? (
            <SignInLink className="m3-press m3-scale96" style={{ ...big, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
              Sign in to bet
            </SignInLink>
          ) : (
            <button
              onClick={openBet}
              disabled={!ready}
              className="m3-press m3-scale96"
              style={{ ...big, background: ready ? (side === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)') : 'var(--raise2)', color: ready ? '#000' : 'var(--dim)', boxShadow: ready ? 'var(--edge)' : 'none' }}
            >
              {ready ? `Bet ${usdc2(amount!)} USDC on ${name}` : "Can't place this bet"}
            </button>
          )}
          <div style={{ fontSize: 13, color: 'var(--dim)', textAlign: 'center' }}>
            Pays {estimate === null ? '0.00' : usdc2(estimate)} USDC if {name} wins
          </div>
        </>
      )}
      {row.state !== 'open' && claimAmount !== null && (
        <button onClick={openClaim} className="m3-press m3-scale96" style={{ ...big, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)' }}>
          {p?.kind === 'refund' ? 'Claim refund' : 'Claim'} {usdc2(claimAmount)} USDC
        </button>
      )}
      {row.state !== 'open' && (p?.kind === 'won' || p?.kind === 'refund') && p.claimed && (
        <div style={{ fontSize: 14, fontWeight: 700, textAlign: 'center', padding: '14px 0' }}>✓ Claimed {usdc2(p.amount)} USDC · in your balance</div>
      )}
      {(row.state === 'betting_closed' || row.state === 'resolving') && <div style={{ fontSize: 14, color: 'var(--dim)', textAlign: 'center', padding: '14px 8px', lineHeight: 1.4 }}>{closedNote(row.state, m, v.now)}</div>}
      {p?.kind === 'lost' && winner && (
        <div style={{ fontSize: 14, color: 'var(--dim)', textAlign: 'center', padding: '14px 0' }}>
          {winner === 'yes' ? labels.yes : labels.no} won this one. Nothing to claim.
        </div>
      )}
      {(row.state === 'yes_won' || row.state === 'no_won' || row.state === 'refunded') && !p && (
        <div style={{ fontSize: 14, color: 'var(--dim)', textAlign: 'center', padding: '14px 0' }}>This pool is finished. You had no position in it.</div>
      )}
    </div>
  );
}
