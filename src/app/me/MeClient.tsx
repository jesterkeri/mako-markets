'use client';

import { useRef, useState } from 'react';

import { claimTile, ConfirmSheet, TileShareButton, type ConfirmSpec } from '@/components/ConfirmSheet';
import { cardStateOf, PnlShareSheet } from '@/components/PnlShareSheet';
import { SignInLink } from '@/components/signin/SignInLink';
import { explorerUrl } from '@/lib/chain';
import type { MeRound } from '@/lib/me-rounds';
import { profitSeries, sumClaims, type MePosition, type MeRange } from '@/lib/me-stats';
import { usdcExact } from '@/lib/pool-list';
import { V1_ASSET } from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolTx } from '@/lib/use-pool-tx';
import { useRoundTx } from '@/lib/use-round-tx';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';

import { MeDesktop } from './MeDesktop';
import { FeedbackRow, MeMobile } from './MeMobile';
import { BAR, display, type ClaimItem, type Loadable, type MeTab, type MeView } from './MeParts';
import { useMeData } from './use-me-data';
import { useProfileEdit } from './use-profile-edit';

// Me (11a): who you are, what you hold, what you can claim. Every figure is read from the chain (the Pools
// contract); nothing comes from the leaderboard ledger, which lags. Each claim is its own transaction through the
// confirm sheet (19a), exactly as on the pool page.

function walletOf(user: AuthedUser): { kind: 'mako' | 'external'; address: string } {
  return user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress };
}

/// The confirm sheet's words for one claim, fixed when it opens: after the claim lands the refetch clears the
/// claimable amount, and the sheet must still describe what was confirmed.
/// The round claim sheet, as the round page words it (a player's claim: no house fee here).
function roundClaimSpec(r: MeRound): ConfirmSpec {
  const amt = usdcExact(r.claim ?? 0n);
  const refund = r.position.kind === 'refund';
  const rows: ConfirmSpec['rows'] = [{ label: 'Round', value: `#${r.round.id.toString()} · ${V1_ASSET.pair}` }];
  if (r.position.kind === 'won') rows.push({ label: 'Payout', value: `${usdcExact(r.position.payout)} USDC` });
  if (r.position.kind === 'refund') rows.push({ label: 'Refund', value: `${usdcExact(r.position.amount)} USDC` });
  if (r.creatorFee > 0n) rows.push({ label: 'House fee', value: `${usdcExact(r.creatorFee)} USDC` });
  return {
    glyph: '$',
    glyphColor: 'var(--mako-teal)',
    title: `${refund ? 'Claim refund' : 'Claim'} · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: refund ? 'Claiming your refund' : 'Claiming',
    rows,
    note: refund ? 'A refund returns your full stake, with no fee.' : 'Fees were taken when the round settled; the claim pays out the rest.',
    doneTitle: refund ? 'Refund claimed' : r.position.kind === 'won' ? 'You won' : 'Claimed',
    doneBody: `${amt} USDC is in your balance.`,
    doneTile: claimTile(amt, refund),
  };
}

function claimSpec(p: MePosition): ConfirmSpec {
  const amt = usdcExact(p.claim ?? 0n);
  const refund = p.state === 'refunded';
  return {
    glyph: '$',
    glyphColor: 'var(--mako-teal)',
    title: `${refund ? 'Claim refund' : 'Claim'} · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: refund ? 'Claiming your refund' : 'Claiming your winnings',
    rows: [
      { label: 'Pool', value: p.market.question },
      { label: refund ? 'Refund' : 'Payout', value: `${amt} USDC` },
    ],
    note: refund ? 'A refund returns your full stake, with no fee.' : 'Fees were taken when the pool settled; the claim pays out the rest.',
    doneTitle: refund ? 'Refund claimed' : 'You won',
    doneBody: `${amt} USDC is in your balance.`,
    doneTile: claimTile(amt, refund),
  };
}

export function MeClient() {
  const { user, isLoading, isError, refetch } = useUser();
  if (user) return <MeSignedIn user={user} />;
  if (isLoading) return <MeGate kind="loading" />;
  // Never the signed-out prompt when the sign-in check itself failed: the account may well be signed in.
  if (isError) return <MeGate kind="error" onRetry={() => void refetch()} />;
  return <MeGate kind="signed-out" />;
}

function MeSignedIn({ user }: { user: AuthedUser }) {
  const account = accountAddress(user);
  const now = useLiveNowSec();
  const data = useMeData(account, now);
  const edit = useProfileEdit();

  const [range, setRange] = useState<MeRange>('7d');
  const [tab, setTab] = useState<MeTab>('active');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);

  /// Claims that landed from this page, kept as they were when confirmed, so each row reads "Claimed" rather than
  /// vanishing when the refetch drops it from the claimable list.
  const [landed, setLanded] = useState<ReadonlyMap<string, MePosition>>(() => new Map());
  const [sheetSpec, setSheetSpec] = useState<ConfirmSpec | null>(null);
  const claiming = useRef<MePosition | null>(null);
  /// The pool whose claim is in the sheet, when it has a win card to share once the claim lands (Joshua 2026-10-24).
  const [winCard, setWinCard] = useState<{ p: MePosition; open: boolean } | null>(null);
  // Another account signing in on this tab forgets it, so that account never gets this one's card (adversary on
  // ba2ddc0). Reset during render, as the pool page does.
  const [cardAccount, setCardAccount] = useState(account);
  if (cardAccount !== account) {
    setCardAccount(account);
    setWinCard(null);
  }
  const tx = usePoolTx(() => {
    const p = claiming.current;
    if (p) setLanded((prev) => new Map(prev).set(p.market.id.toString(), p));
    data.refetch();
  });
  // Rounds claim from Me too (2026-10-13), through the round's own sponsored transaction, one sheet at a time.
  const [landedRounds, setLandedRounds] = useState<ReadonlyMap<string, MeRound>>(() => new Map());
  const [roundSheetSpec, setRoundSheetSpec] = useState<ConfirmSpec | null>(null);
  const claimingRound = useRef<MeRound | null>(null);
  const roundTx = useRoundTx(() => {
    const r = claimingRound.current;
    if (r) setLandedRounds((prev) => new Map(prev).set(r.round.id.toString(), r));
    data.refetch();
  });
  const openClaim = (c: ClaimItem) => {
    if (tx.tx || roundTx.tx) return;
    if (c.kind === 'pool') {
      if (c.p.claim === null) return;
      claiming.current = c.p;
      setSheetSpec(claimSpec(c.p));
      setWinCard(cardStateOf(c.p) === 'result' ? { p: c.p, open: false } : null);
      tx.open({ kind: 'claim', marketId: c.p.market.id });
    } else {
      if (c.r.claim === null) return;
      claimingRound.current = c.r;
      setRoundSheetSpec(roundClaimSpec(c.r));
      roundTx.open({ kind: 'claim', roundId: c.r.round.id });
    }
  };

  const name = user.displayName?.trim() || null;
  const label = name ?? formatAddress(account);
  const chain = data.chain;
  const pending = chain.status === 'ready' ? chain.stats.claims.filter((p) => !landed.has(p.market.id.toString())) : [];
  const pendingRounds = chain.status === 'ready' ? chain.roundClaims.filter((r) => !landedRounds.has(r.round.id.toString())) : [];
  const claimItems: ClaimItem[] = [
    ...pending.map((p): ClaimItem => ({ kind: 'pool', p, landed: false })),
    ...pendingRounds.map((r): ClaimItem => ({ kind: 'round', r, landed: false })),
    ...[...landed.values()].map((p): ClaimItem => ({ kind: 'pool', p, landed: true })),
    ...[...landedRounds.values()].map((r): ClaimItem => ({ kind: 'round', r, landed: true })),
  ];
  const ready: Loadable<bigint> =
    chain.status === 'ready' ? { status: 'ready', value: sumClaims(pending) + pendingRounds.reduce((s, r) => s + (r.claim ?? 0n), 0n) } : chain;

  const view: MeView = {
    user,
    account,
    name,
    label,
    initial: [...label][0]?.toUpperCase() ?? '?',
    emailAccount: user.authType === 'magic',
    balance: data.balance,
    chain,
    ready,
    claimItems,
    pendingClaims: pending.length + pendingRounds.length,
    allClaimed: pending.length + pendingRounds.length === 0 && (landed.size + landedRounds.size > 0 || (chain.status === 'ready' && chain.stats.claimedBefore)),
    series: chain.status === 'ready' && now !== null ? profitSeries(chain.positions, now, range) : null,
    now,
    labelsOf: data.labelsOf,
    range,
    setRange,
    tab,
    setTab,
    openClaim,
    retry: data.refetch,
    explorerHref: explorerUrl('address', account),
    edit,
    editing,
    draft,
    setDraft: (s) => {
      setDraft(s);
      edit.clearNameError();
    },
    startEdit: () => {
      setDraft(name ?? '');
      edit.clearNameError();
      setEditing(true);
    },
    cancelEdit: () => {
      setEditing(false);
      edit.clearNameError();
    },
    saveDraft: () => {
      void edit.saveName(draft).then((ok) => {
        if (ok) setEditing(false);
      });
    },
    photoOpen,
    setPhotoOpen: (b) => {
      setPhotoOpen(b);
      if (!b) edit.clearPhotoError();
    },
  };

  const spec = tx.tx ? sheetSpec : null;
  const roundSpec = roundTx.tx ? roundSheetSpec : null;
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <MeDesktop {...view} />
      </div>
      <div className="mk-mob mk-m">
        <MeMobile {...view} />
      </div>
      {spec && (
        <ConfirmSheet
          spec={spec}
          phase={tx.phase}
          wallet={walletOf(user)}
          onConfirm={tx.confirm}
          onCancel={tx.close}
          onRetry={tx.retry}
          onClose={tx.close}
          doneExtra={
            tx.phase.step === 'done' && winCard ? (
              <TileShareButton
                onClick={() => {
                  setWinCard({ p: winCard.p, open: true });
                  tx.close();
                }}
              >
                Share your win
              </TileShareButton>
            ) : undefined
          }
        />
      )}
      {winCard?.open && (
        <PnlShareSheet
          poolId={winCard.p.market.id}
          question={winCard.p.market.question}
          stake={winCard.p.bet}
          state="result"
          account={account}
          labels={data.labelsOf(winCard.p)}
          onClose={() => setWinCard(null)}
        />
      )}
      {roundSpec && (
        <ConfirmSheet spec={roundSpec} phase={roundTx.phase} wallet={walletOf(user)} onConfirm={roundTx.confirm} onCancel={roundTx.close} onRetry={roundTx.retry} onClose={roundTx.close} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Before the account is known: checking, signed out, or the check failed.

function MeGate({ kind, onRetry }: { kind: 'loading' | 'signed-out' | 'error'; onRetry?: () => void }) {
  const title = kind === 'error' ? 'Can’t check your sign-in' : 'Me';
  const body =
    kind === 'error'
      ? 'Mako Market couldn’t reach its server just now. Your balance and bets are safe on-chain.'
      : 'Sign in to see your balance, your bets and anything you can claim.';
  const tourAnchor = kind === 'signed-out' ? 'test-usdc' : undefined;
  const action = (className: string, style: React.CSSProperties) =>
    kind === 'error' ? (
      <button type="button" onClick={onRetry} className={className} style={style}>
        Try again
      </button>
    ) : (
      <SignInLink className={className} style={style}>
        Sign in
      </SignInLink>
    );
  if (kind === 'loading') {
    return (
      <>
        <div className="mk-desk mk-desk-frame">
          <div aria-busy="true" aria-label="Loading" style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 4px 24px' }}>
            <div style={{ width: 96, height: 96, borderRadius: 9999, background: BAR }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ width: 280, height: 48, borderRadius: 10, background: BAR }} />
              <div style={{ width: 200, height: 14, borderRadius: 8, background: BAR }} />
            </div>
          </div>
        </div>
        <div className="mk-mob mk-m">
          <div aria-busy="true" aria-label="Loading" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 20px 0' }}>
            <div style={{ width: 72, height: 72, borderRadius: 9999, background: BAR }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ width: 180, height: 26, borderRadius: 8, background: BAR }} />
              <div style={{ width: 130, height: 14, borderRadius: 8, background: BAR }} />
            </div>
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <div role={kind === 'error' ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '72px 4px 80px' }}>
          {/* Signed out, How to play's test-USDC step points here: the address it needs comes with signing in. */}
          <div data-tour-anchor={tourAnchor} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <h1 style={{ margin: 0, ...display, fontSize: 56, lineHeight: 1, letterSpacing: '-0.04em' }}>{title}</h1>
            <div style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--dim)', marginTop: 12, maxWidth: 520 }}>{body}</div>
            {action('mk-press97', { height: 52, display: 'inline-flex', alignItems: 'center', padding: '0 24px', marginTop: 26, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...display, fontSize: 16, textDecoration: 'none' })}
          </div>
        </div>
      </div>
      <div className="mk-mob mk-m">
        <div style={{ padding: '18px 12px 0' }}>
          <div role={kind === 'error' ? 'alert' : undefined} data-tour-anchor={tourAnchor} style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '26px 20px 20px', textAlign: 'center' }}>
            <h1 style={{ margin: 0, ...display, fontSize: 30, lineHeight: 1.1, letterSpacing: '-0.02em' }}>{title}</h1>
            <div style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.72, marginTop: 8 }}>{body}</div>
            {action('m3-press', { width: '100%', height: 54, marginTop: 18, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' })}
          </div>
        </div>
        <div style={{ padding: '10px 12px 0' }}>
          <FeedbackRow />
        </div>
      </div>
    </>
  );
}
