'use client';

import { useEffect, useState } from 'react';

import { SheetFrame, Svg } from '@/components/ConfirmSheet';
import type { MeBetWire } from '@/app/api/me/bets/route';
import type { MePosition } from '@/lib/me-stats';
import { cardPath } from '@/lib/pnl-card';
import { shareText } from '@/lib/pool-invite';
import { dayTime } from '@/lib/pool-rules';
import { usdc2 } from '@/lib/pool-list';

// Share a settled pool's result (docs/pnl-share-card): one PnL card per bet (owner, 2026-10-23). The sheet lists the
// account's bets on the pool, from its own-account route (/api/me/bets), and shows the chosen bet's card with Download,
// Copy image and Share to X. The ledger behind that route runs behind the chain, so the rows are checked against the
// stake Me read on chain: until they add up, the sheet says so instead of offering a partial list.

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const mono: React.CSSProperties = { fontFamily: 'var(--mako-font-mono)' };
const CLOSE = 'M7 7l10 10M17 7L7 17';

type Labels = { yes: string; no: string };

/// Only a settled win or loss has a card; a refund has none.
export const hasPnlCard = (p: MePosition) => p.settlement?.kind === 'won' || p.settlement?.kind === 'lost';

export function PnlShareButton({ p, account, labels, style }: { p: MePosition; account: `0x${string}`; labels: Labels; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Share your result on ${p.market.question}`}
        className="mk-press96"
        style={{ height: 32, padding: '0 14px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', ...mono, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', ...style }}
      >
        Share
      </button>
      {open && <PnlShareSheet p={p} account={account} labels={labels} onClose={() => setOpen(false)} />}
    </>
  );
}

type Load = { status: 'loading' } | { status: 'error' } | { status: 'behind' } | { status: 'ready'; bets: MeBetWire[] };

/// The rows add up to the stake read on chain, side by side.
export function betsMatchStake(bets: readonly MeBetWire[], stake: { yes: bigint; no: bigint }): boolean {
  const sum = (yes: boolean) => bets.filter((b) => b.isYes === yes).reduce((s, b) => s + BigInt(b.amount), 0n);
  return bets.length > 0 && sum(true) === stake.yes && sum(false) === stake.no;
}

function PnlShareSheet({ p, account, labels, onClose }: { p: MePosition; account: `0x${string}`; labels: Labels; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [pick, setPick] = useState(0);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { id } = p.market;
  const { yes, no } = p.bet;
  useEffect(() => {
    let live = true;
    fetch(`/api/me/bets?account=${account}&pool=${id.toString()}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const { bets } = (await r.json()) as { bets: MeBetWire[] };
        if (live) setLoad(betsMatchStake(bets, { yes, no }) ? { status: 'ready', bets } : { status: 'behind' });
      })
      .catch(() => live && setLoad({ status: 'error' }));
    return () => {
      live = false;
    };
  }, [account, id, yes, no]);

  const bet = load.status === 'ready' ? load.bets[pick] : null;
  const page = bet ? cardPath(p.market.id, bet.tx, bet.log) : null;
  const image = page ? `${page}/opengraph-image` : null;

  const pngBlob = async () => {
    const r = await fetch(image!);
    if (!r.ok) throw new Error(String(r.status));
    return r.blob();
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await pngBlob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `mako-market-pool-${p.market.id.toString()}-bet-${pick + 1}.png`;
      a.click();
      URL.revokeObjectURL(url);
      setDone('Downloaded');
    } catch {
      setDone('Download failed');
    }
  };
  const copy = async () => {
    try {
      // The blob goes in as a promise, so Safari keeps the tap's permission while the image loads.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob() })]);
      setDone('Image copied');
    } catch {
      setDone('Copy failed');
    }
  };
  const xHref = page ? `https://x.com/intent/tweet?text=${encodeURIComponent(shareText(p.market.question))}&url=${encodeURIComponent(`${window.location.origin}${page}`)}` : '';
  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  const action: React.CSSProperties = { flex: 1, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 9999, ...mono, fontSize: 13, fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' };

  return (
    <SheetFrame label="Share your result" onScrim={onClose} width={640} yellowOnDark={false}>
      {(variant) => (
        <div style={{ maxHeight: variant === 'mobile' ? 'calc(100dvh - 72px)' : 'calc(100dvh - 160px)', overflowY: 'auto', overscrollBehavior: 'contain', padding: 2, margin: variant === 'mobile' ? '-6px -2px -2px' : -2 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ ...display, fontSize: 22 }}>Share your result</span>
            <button onClick={onClose} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CLOSE} size={16} />
            </button>
          </div>

          {load.status === 'loading' && <Note>Loading your bets…</Note>}
          {load.status === 'error' && <Note>Your bets could not be loaded. Close this and try again.</Note>}
          {load.status === 'behind' && <Note>Your latest bets on this pool are still being counted. Try again in a few minutes.</Note>}

          {load.status === 'ready' && load.bets.length > 1 && (
            <div role="radiogroup" aria-label="Which bet" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {load.bets.map((b, i) => (
                <button
                  key={`${b.tx}:${b.log}`}
                  type="button"
                  role="radio"
                  aria-checked={i === pick}
                  onClick={() => {
                    setPick(i);
                    setDone(null);
                  }}
                  className="m3-press"
                  style={{ display: 'flex', alignItems: 'center', gap: 10, height: 40, padding: '0 14px', borderRadius: 12, background: i === pick ? 'var(--mako-canvas-fg)' : 'var(--raise)', color: i === pick ? 'var(--mako-canvas)' : 'var(--mako-canvas-fg)', ...mono, fontSize: 12, fontWeight: 700, textAlign: 'left' }}
                >
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dayTime(b.at)}</span>
                  <span>{b.isYes ? labels.yes : labels.no}</span>
                  <span>{usdc2(BigInt(b.amount))} USDC</span>
                </button>
              ))}
            </div>
          )}

          {image && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={image} src={image} width={1600} height={900} alt={`Your PnL card for ${p.market.question}`} style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', borderRadius: 14, background: '#000' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button type="button" onClick={download} className="m3-press" style={{ ...action, background: 'var(--raise)', color: 'var(--mako-canvas-fg)' }}>
                  Download
                </button>
                {canCopy && (
                  <button type="button" onClick={copy} className="m3-press" style={{ ...action, background: 'var(--raise)', color: 'var(--mako-canvas-fg)' }}>
                    Copy image
                  </button>
                )}
                <a href={xHref} target="_blank" rel="noopener noreferrer" className="m3-press" style={{ ...action, background: '#000', color: '#fff' }}>
                  Share to X
                </a>
              </div>
              <div aria-live="polite" style={{ ...mono, fontSize: 12, color: 'var(--dim)', minHeight: 18, marginTop: 8 }}>
                {done}
              </div>
            </>
          )}
        </div>
      )}
    </SheetFrame>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 14, borderRadius: 12, background: 'var(--raise)', ...mono, fontSize: 12 }}>{children}</div>;
}
