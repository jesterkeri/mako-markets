'use client';

import { useRef, useState } from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { SignInLink } from '@/components/signin/SignInLink';
import { explorerUrl } from '@/lib/chain';
import { profitSeries, sumClaims, type MePosition, type MeRange } from '@/lib/me-stats';
import { usdcExact } from '@/lib/pool-list';
import { useLiveNowSec } from '@/lib/use-live-clock';
import { usePoolTx } from '@/lib/use-pool-tx';
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
    doneTitle: refund ? 'Refund claimed' : 'Claimed',
    doneBody: `${amt} USDC is in your balance.`,
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
  const tx = usePoolTx(() => {
    const p = claiming.current;
    if (p) setLanded((prev) => new Map(prev).set(p.market.id.toString(), p));
    data.refetch();
  });
  const openClaim = (p: MePosition) => {
    if (p.claim === null || tx.tx) return;
    claiming.current = p;
    setSheetSpec(claimSpec(p));
    tx.open({ kind: 'claim', marketId: p.market.id });
  };

  const name = user.displayName?.trim() || null;
  const label = name ?? formatAddress(account);
  const chain = data.chain;
  const pending = chain.status === 'ready' ? chain.stats.claims.filter((p) => !landed.has(p.market.id.toString())) : [];
  const claimItems: ClaimItem[] = [...pending.map((p) => ({ p, landed: false })), ...[...landed.values()].map((p) => ({ p, landed: true }))];
  const ready: Loadable<bigint> = chain.status === 'ready' ? { status: 'ready', value: sumClaims(pending) } : chain;

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
    pendingClaims: pending.length,
    allClaimed: pending.length === 0 && (landed.size > 0 || (chain.status === 'ready' && chain.stats.claimedBefore)),
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
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <MeDesktop {...view} />
      </div>
      <div className="mk-mob mk-m">
        <MeMobile {...view} />
      </div>
      {spec && <ConfirmSheet spec={spec} phase={tx.phase} wallet={walletOf(user)} onConfirm={tx.confirm} onCancel={tx.close} onRetry={tx.retry} onClose={tx.close} />}
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
