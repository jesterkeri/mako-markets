'use client';

import Link from 'next/link';
import { useState } from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';
import { CREATOR_EARNING_LABEL, creatorEarningAmount, creatorEarningPill, creatorFeeConfirmSpec } from '@/components/CreatorEarnings';
import { useCreatorClaimHolds } from '@/lib/creator-claim-pending';
import { creatorEarningNote, creatorEarningsFor, type CreatorEarning } from '@/lib/creator-earnings';
import { useAllMarkets } from '@/lib/hooks';
import { usdcExact } from '@/lib/pool-list';
import { usePoolTx } from '@/lib/use-pool-tx';
import type { AuthedUser } from '@/lib/use-user';

// Me: Creator earnings. Every V4 pool this account created that carries a creator fee, with what it pays: claimable
// rows (and their total) with a Claim button each, then claimed and forfeited rows, then a count of pools that are
// refunded or not resolved yet. Self-contained, so Me mounts it with one line: it reads the same every-pool chain read
// Me already makes (useAllMarkets, the same cached query, no extra RPC) and has its own confirm sheet. The claim goes
// through usePoolTx exactly like a winnings claim (email accounts gas-free, wallet accounts from the wallet). Renders
// nothing for an account that created no fee-bearing pool.

const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };

function walletOf(user: AuthedUser): { kind: 'mako' | 'external'; address: string } {
  return user.authType === 'magic' ? { kind: 'mako', address: user.safeAddress } : { kind: 'external', address: user.walletAddress };
}

export function CreatorEarningsSection({ user, account, variant }: { user: AuthedUser; account: `0x${string}`; variant: 'desktop' | 'mobile' }) {
  const marketsQ = useAllMarkets();
  const holds = useCreatorClaimHolds();
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  /// After a claim lands, the refetch flips the pool's creatorFeeClaimed on chain and its row moves to Claimed.
  const tx = usePoolTx(() => marketsQ.refetch());
  const openClaim = (e: CreatorEarning) => {
    if (e.state !== 'claimable' || tx.tx) return;
    setSpec(creatorFeeConfirmSpec(e));
    tx.open({ kind: 'creatorFee', marketId: e.market.id });
  };
  const sheet = tx.tx && spec ? <ConfirmSheet spec={spec} phase={tx.phase} wallet={walletOf(user)} onConfirm={tx.confirm} onCancel={tx.close} onRetry={tx.retry} onClose={tx.close} /> : null;

  const mobile = variant === 'mobile';
  const frame = (children: React.ReactNode) =>
    mobile ? (
      <div style={{ padding: '12px 12px 0' }}>
        <section aria-label="Creator earnings" style={{ borderRadius: 32, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px' }}>
          {children}
        </section>
      </div>
    ) : (
      <section aria-label="Creator earnings" style={{ marginTop: 22, paddingTop: 14, boxShadow: 'inset 0 1px 0 var(--line)' }}>
        {children}
      </section>
    );
  const dim: React.CSSProperties = mobile ? { opacity: 0.65 } : { color: 'var(--dim)' };
  const heading = (right: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: 6 }}>
      <span style={mobile ? { ...display, fontSize: 22 } : { ...mono, fontSize: 11, color: 'var(--dim)' }}>{mobile ? 'Creator earnings' : 'CREATOR EARNINGS'}</span>
      {right}
    </div>
  );

  // The chain read failed with nothing read before: an error, never zeros.
  if (marketsQ.isError) {
    return frame(
      <>
        {heading(null)}
        <div role="alert" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Couldn’t read your pools from Monad, so creator earnings are unknown right now.
          <button type="button" onClick={() => marketsQ.refetch()} className={mobile ? 'm3-press' : 'mk-press97'} style={{ display: 'block', marginTop: 10, height: 36, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: 'var(--mako-ink)', boxShadow: 'var(--edge)', fontSize: 13, fontWeight: 800 }}>
            Try again
          </button>
        </div>
      </>,
    );
  }
  if (marketsQ.isLoading) {
    return frame(
      <>
        {heading(null)}
        <div aria-busy="true" style={{ ...dim, fontSize: 13 }}>
          Reading your pools…
        </div>
      </>,
    );
  }

  const { rows, claimableTotal, claimable } = creatorEarningsFor(marketsQ.markets, account, (id) => holds.has(id.toString()));
  if (rows.length === 0) return sheet;
  const listed = rows.filter((e) => e.state === 'claimable' || e.state === 'confirming' || e.state === 'claimed' || e.state === 'forfeited');
  const refunded = rows.filter((e) => e.state === 'refunded').length;
  const unresolved = rows.filter((e) => e.state === 'unresolved').length;
  const rest = [unresolved > 0 && `${unresolved} not resolved yet`, refunded > 0 && `${refunded} refunded, no fee`].filter(Boolean).join(' · ');

  return (
    <>
      {frame(
        <>
          {heading(
            <span style={{ ...(mobile ? { fontSize: 13, fontWeight: 800 } : { ...mono, fontSize: 12, fontWeight: 700 }), fontVariantNumeric: 'tabular-nums' }}>
              {claimable > 0 ? `${usdcExact(claimableTotal)} USDC to claim` : 'Nothing to claim'}
            </span>,
          )}
          {listed.map((e) => (
            <div key={e.market.id.toString()} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', boxShadow: mobile ? 'inset 0 -1px 0 var(--m3-inv-2)' : 'inset 0 1px 0 var(--line)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link href={`/pools/${e.market.id}`} style={{ display: 'block', fontWeight: mobile ? 800 : 700, fontSize: mobile ? 15 : 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', textDecoration: 'none' }}>
                  {e.market.question}
                </Link>
                <div style={{ ...(mobile ? {} : mono), ...dim, fontSize: mobile ? 13 : 11, lineHeight: 1.45, marginTop: 3 }}>{creatorEarningNote(e)}</div>
              </div>
              {e.state === 'claimable' ? (
                <button
                  type="button"
                  onClick={() => openClaim(e)}
                  className={mobile ? 'm3-press m3-scale96' : 'mk-press97'}
                  style={{ flex: 'none', height: mobile ? 38 : 36, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: 'var(--mako-ink)', boxShadow: mobile ? undefined : 'var(--edge)', ...(mobile ? { fontSize: 13, fontWeight: 800 } : { ...mono, fontSize: 12, fontWeight: 700 }), whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
                >
                  Claim {usdcExact(e.fee)} USDC
                </button>
              ) : (
                <span style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {creatorEarningAmount(e) && <span style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{creatorEarningAmount(e)}</span>}
                  <span style={creatorEarningPill(e.state, mobile)}>{CREATOR_EARNING_LABEL[e.state]}</span>
                </span>
              )}
            </div>
          ))}
          {rest && <div style={{ ...dim, ...(mobile ? {} : mono), fontSize: mobile ? 13 : 11, marginTop: 10 }}>Also: {rest}.</div>}
        </>,
      )}
      {sheet}
    </>
  );
}
