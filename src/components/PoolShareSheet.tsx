'use client';

import { useEffect, useState } from 'react';

import { SheetFrame, Svg } from '@/components/ConfirmSheet';
import { CardPreview } from '@/components/PnlShareSheet';
import type { MarketWithId } from '@/lib/contract';
import { intentUrl, poolInviteLink, shareText } from '@/lib/pool-invite';

// Share (15a): a pool's invite. The card is the pool's link preview itself (opengraph-image.tsx, the share card's
// black frame; Joshua 2026-10-26: pool links get the new card design, in the sheet too), so what the sheet shows is
// what a pasted link shows, with Download and Copy image, then the share targets. A dialog on desktop and a bottom
// sheet on mobile, over one scrim (SheetFrame), in both themes.

type Props = {
  market: MarketWithId;
  onClose: () => void;
};

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const CLOSE = 'M7 7l10 10M17 7L7 17';

export function PoolShareSheet({ market, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const id = market.id.toString();
  return (
    <SheetFrame label="Share" onScrim={onClose} width={640} yellowOnDark={false}>
      {(variant) => (
        // Scrolls when the screen is shorter than the sheet. The 2px padding keeps the card's ring inside the scroll
        // box; on mobile the sheet's 16px gap under the handle is pulled up to the design's 12px.
        <div
          style={{
            maxHeight: variant === 'mobile' ? 'calc(100dvh - 72px)' : 'calc(100dvh - 160px)',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: 2,
            margin: variant === 'mobile' ? '-6px -2px -2px' : -2,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ ...display, fontSize: 22 }}>Share</span>
            <button onClick={onClose} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CLOSE} size={16} />
            </button>
          </div>
          <CardPreview poolId={market.id} image={`/pools/${id}/opengraph-image`} question={market.question} fileName={`mako-market-pool-${id}.png`} alt={`Share card for ${market.question}`} />
        </div>
      )}
    </SheetFrame>
  );
}

/// The share targets (X, WhatsApp, Telegram, the device's own share) and the Copy link box, for a pool's invite or,
/// with `path`, one page of the pool such as a bet's share card.
export function ShareLinks({ id, question, path }: { id: bigint; question: string; path?: string }) {
  const link = poolInviteLink(id, 'link', path);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  // The sheet only exists after a tap, so reading the browser here never meets server rendering.
  const [canShare] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function');

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  const nativeShare = async () => {
    try {
      await navigator.share({ title: question, text: shareText(question), url: link });
    } catch {
      // Cancelled, or the device refused: nothing was sent and there is nothing to undo.
    }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 2, marginTop: 16 }}>
        <Target href={intentUrl('x', id, question, path)} label="X" name="Share on X" bg="#000" fg="#fff" icon={<XIcon />} />
        <Target href={intentUrl('whatsapp', id, question, path)} label="WhatsApp" name="Share on WhatsApp" bg="#25D366" fg="#fff" icon={<WhatsAppIcon />} />
        <Target href={intentUrl('telegram', id, question, path)} label="Telegram" name="Share on Telegram" bg="#229ED9" fg="#fff" icon={<TelegramIcon />} />
        {canShare && <Target onClick={nativeShare} label="More" name="More ways to share" bg="var(--raise2)" fg="var(--mako-canvas-fg)" icon={<MoreIcon />} />}
        {/* Copy sits in the row as one more icon (Joshua 2026-10-26): the link pill took a second row. */}
        <Target
          onClick={copyLink}
          label={copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Failed' : 'Copy'}
          name={copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy link'}
          bg="var(--mako-signal)"
          fg="#000"
          icon={<CopyIcon />}
        />
      </div>
    </>
  );
}

type TargetProps = { label: string; bg: string; fg: string; icon: React.ReactNode; name: string } & (
  | { href: string; onClick?: never }
  | { onClick: () => void; href?: never }
);

/// One share target: a 48px round icon over its label.
function Target({ label, bg, fg, icon, ...t }: TargetProps) {
  const item: React.CSSProperties = { flex: '0 1 auto', minWidth: 'min-content', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'inherit', textDecoration: 'none', textAlign: 'center' };
  const circle = (
    <span aria-hidden="true" style={{ flex: 'none', width: 48, height: 48, borderRadius: 9999, background: bg, color: fg, boxShadow: 'var(--edge), inset 0 0 0 1px rgba(255,255,255,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {icon}
    </span>
  );
  if (t.href) {
    return (
      <a href={t.href} target="_blank" rel="noopener noreferrer" aria-label={t.name} className="m3-press" style={item}>
        {circle}
        <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
      </a>
    );
  }
  return (
    <button onClick={t.onClick} aria-label={t.name} className="m3-press" style={item}>
      {circle}
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

function XIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4l16 16M20 4L4 20" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.8L3.5 20.5l4.3-1.1A8.5 8.5 0 1 0 12 3.5z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M9 8.5c0 3.3 2.7 6.5 6.5 6.5l1-1.4-2-1-1 .8c-1-.4-2.3-1.7-2.7-2.7l.8-1-1-2z" fill="currentColor" />
    </svg>
  );
}

function TelegramIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 4.5L3.5 11l5.5 2 2 6 3-4 4.5 3.5z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M9 13l9-6.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15.5 5.5v-.5a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 5v8A1.5 1.5 0 0 0 6 14.5h.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V4M8 8l4-4 4 4M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
