'use client';

import type { ConfirmSpec } from '@/components/ConfirmSheet';
import { explorerUrl } from '@/lib/chain';
import { creatorEarningNote, ratioPct, type CreatorEarning, type CreatorEarningState } from '@/lib/creator-earnings';
import { usdcExact } from '@/lib/pool-list';
import { formatAddress } from '@/lib/user-display';

// Creator earnings on the pool page: the pool's creator, and only the creator, sees what the pool pays them and, when
// it is claimable, one Claim button that goes through the confirm sheet like every other claim. Every figure is the
// pool's own on-chain state (src/lib/creator-earnings.ts). Colours are brand tokens, so both themes work.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

export const CREATOR_EARNING_LABEL: Record<CreatorEarningState, string> = {
  claimable: 'Ready to claim',
  confirming: 'Confirming',
  claimed: 'Claimed',
  forfeited: 'Forfeited',
  refunded: 'Refunded, no fee',
  unresolved: 'Not resolved yet',
};

/// The pill behind a state label. Ink text on the brand colours; the neutral pill follows the surface it sits on.
export function creatorEarningPill(state: CreatorEarningState, onInverse = false): React.CSSProperties {
  const bg: Record<CreatorEarningState, string> = {
    claimable: 'var(--mako-signal)',
    confirming: onInverse ? 'var(--m3-inv-2)' : 'var(--raise2)',
    claimed: 'var(--mako-teal)',
    forfeited: 'var(--mako-red)',
    refunded: 'var(--mako-cyan)',
    unresolved: onInverse ? 'var(--m3-inv-2)' : 'var(--raise2)',
  };
  return {
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    padding: '0 10px',
    borderRadius: 9999,
    background: bg[state],
    color: state === 'unresolved' || state === 'confirming' ? 'inherit' : 'var(--mako-ink)',
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  };
}

/// The amount a row shows: the fee once it is final and payable (claimable / claimed), nothing otherwise. A forfeit
/// pays 0 and its note names the share that went to the winners; a refunded pool pays no fee; an unresolved pool's
/// fee is not final.
export function creatorEarningAmount(e: CreatorEarning): string | null {
  if (e.state === 'claimable' || e.state === 'confirming' || e.state === 'claimed') return `${usdcExact(e.fee)} USDC`;
  return null;
}

/// The confirm sheet's words for one creator-fee claim, fixed when it opens.
export function creatorFeeConfirmSpec(e: CreatorEarning): ConfirmSpec {
  const amt = usdcExact(e.fee);
  return {
    glyph: '$',
    glyphColor: 'var(--mako-teal)',
    title: `Claim creator earnings · ${amt} USDC`,
    confirmLabel: `Confirm · ${amt} USDC`,
    pendingTitle: 'Claiming your creator earnings',
    rows: [
      { label: 'Pool', value: e.market.question },
      { label: 'Creator fee', value: `${ratioPct(BigInt(e.market.creatorFeeBpsSnapshot))}% of ${usdcExact(e.market.totalYes + e.market.totalNo)} USDC` },
      { label: 'Earnings', value: `${amt} USDC` },
    ],
    note: 'Your share as the creator of this pool. It is paid once.',
    doneTitle: 'Creator earnings claimed',
    doneBody: `${amt} USDC is in your balance.`,
    doneSecondary: { label: 'View in Me', href: '/me' },
  };
}

/// The pool page's creator-earnings block. Render it only for the pool's creator (see PoolClient).
export function CreatorEarningsCard({
  earning: e,
  onClaim,
  lastTx,
  variant,
}: {
  earning: CreatorEarning;
  onClaim: () => void;
  lastTx: string | undefined;
  variant: 'desktop' | 'mobile';
}) {
  const amount = creatorEarningAmount(e);
  const claimButton =
    e.state === 'claimable' ? (
      <button
        type="button"
        onClick={onClaim}
        className={variant === 'desktop' ? 'mk-press96' : 'm3-press'}
        style={{ width: '100%', marginTop: 14, height: variant === 'desktop' ? 52 : 54, borderRadius: 9999, background: 'var(--mako-signal)', color: 'var(--mako-ink)', boxShadow: 'var(--edge)', ...display, fontSize: variant === 'desktop' ? 17 : 16 }}
      >
        Claim creator earnings {usdcExact(e.fee)} USDC
      </button>
    ) : null;
  const txLink = e.state === 'claimed' && lastTx ? (
    <a href={explorerUrl('tx', lastTx)} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
      tx {formatAddress(lastTx)} ↗
    </a>
  ) : null;

  if (variant === 'desktop') {
    return (
      <section aria-label="Creator earnings" style={{ borderTop: '1px solid var(--line)', padding: '14px 4px 0' }}>
        <div style={{ ...mono, fontSize: 11, color: 'var(--dim)' }}>CREATOR EARNINGS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={creatorEarningPill(e.state)}>{CREATOR_EARNING_LABEL[e.state]}</span>
          {amount && <span style={{ ...display, fontSize: 26, letterSpacing: '-0.02em' }}>{amount}</span>}
        </div>
        <div style={{ ...mono, fontSize: 12, lineHeight: 1.5, marginTop: 10, color: 'var(--dim)' }}>
          {creatorEarningNote(e)}
          {txLink && <> · {txLink}</>}
        </div>
        {claimButton}
      </section>
    );
  }
  return (
    <section aria-label="Creator earnings" style={{ marginTop: 10, borderRadius: 24, background: 'var(--raise)', padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 13, color: 'var(--dim)' }}>Creator earnings</span>
        <span style={creatorEarningPill(e.state)}>{CREATOR_EARNING_LABEL[e.state]}</span>
      </div>
      {amount && <div style={{ fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums', marginTop: 6 }}>{amount}</div>}
      <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--dim)', marginTop: 6 }}>
        {creatorEarningNote(e)}
        {txLink && <> · {txLink}</>}
      </div>
      {claimButton}
    </section>
  );
}
