'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';

import { SheetFrame, Svg } from '@/components/ConfirmSheet';
import { Logo } from '@/components/Logo';
import type { MarketWithId } from '@/lib/contract';
import { intentUrl, linkDisplay, poolInviteCard, poolInviteLink, shareText, type InviteCard } from '@/lib/pool-invite';

// Share (15a): the invite card for a pool, with its link, a QR of it, and the share targets. A dialog on desktop and
// a bottom sheet on mobile, over one scrim (SheetFrame), in both themes. The card itself is the design's dark card in
// both themes, as drawn. It shows the pool page's own figures, never a number it could not read from the chain.

type Props = {
  market: MarketWithId;
  now: number;
  /// The side names the pool page shows (a house pool can name its own).
  labels: { yes: string; no: string };
  /// The creator label the pool page shows ("Hosted by …").
  by: string;
  onClose: () => void;
};

const display: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800 };
const CLOSE = 'M7 7l10 10M17 7L7 17';

export function PoolShareSheet({ market, now, labels, by, onClose }: Props) {
  const card = poolInviteCard(market, now, labels);
  const link = poolInviteLink(market.id, 'link');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  // The sheet only exists after a tap, so reading the browser here never meets server rendering.
  const [canShare] = useState(() => typeof navigator !== 'undefined' && typeof navigator.share === 'function');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
      await navigator.share({ title: market.question, text: shareText(market.question), url: link });
    } catch {
      // Cancelled, or the device refused: nothing was sent and there is nothing to undo.
    }
  };

  return (
    <SheetFrame label="Share" onScrim={onClose} width={500} yellowOnDark={false}>
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

          <InviteCardView card={card} question={market.question} by={by} link={link} variant={variant} />

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4, padding: '0 6px', marginTop: 16 }}>
            <Target href={intentUrl('x', market.id, market.question)} label="X" name="Share on X" bg="#000" fg="#fff" icon={<XIcon />} />
            <Target href={intentUrl('whatsapp', market.id, market.question)} label="WhatsApp" name="Share on WhatsApp" bg="#25D366" fg="#fff" icon={<WhatsAppIcon />} />
            <Target href={intentUrl('telegram', market.id, market.question)} label="Telegram" name="Share on Telegram" bg="#229ED9" fg="#fff" icon={<TelegramIcon />} />
            {canShare && <Target onClick={nativeShare} label="More" name="More ways to share" bg="var(--raise2)" fg="var(--mako-canvas-fg)" icon={<MoreIcon />} />}
            {/* Rendering the card to an image needs a new dependency, which waits for approval: the slot stays, off. */}
            <Target comingSoon label="Save image" bg="var(--mako-paper)" fg="#000" icon={<SaveIcon />} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, padding: '6px 6px 6px 18px', borderRadius: 9999, background: '#000', color: '#EBE5D9', boxShadow: 'inset 0 0 0 1.5px var(--mako-signal)' }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{linkDisplay(link)}</span>
            <button onClick={copyLink} className="m3-press" style={{ flex: 'none', height: 42, padding: '0 18px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap' }}>
              {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy link'}
            </button>
          </div>
        </div>
      )}
    </SheetFrame>
  );
}

function InviteCardView({ card, question, by, link, variant }: { card: InviteCard; question: string; by: string; link: string; variant: 'desktop' | 'mobile' }) {
  const desk = variant === 'desktop';
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 30, background: '#0b0b0b', color: '#EBE5D9', boxShadow: 'var(--edge), 0 0 0 1.5px #262626' }}>
      <div style={{ padding: '20px 22px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'flex', color: '#EBE5D9' }}>
            <Logo size={24} />
          </span>
          <span style={{ ...display, fontSize: 15 }}>Mako Market</span>
          <span style={{ marginLeft: 'auto', height: 26, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 9999, background: card.pill.colour, color: '#000', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}>
            {card.open && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: '#000' }} />}
            {card.pill.label}
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '.08em', opacity: 0.6, marginTop: 18, overflowWrap: 'break-word' }}>
          {card.cat} · HOSTED BY {by}
        </div>
        <div style={{ ...display, fontSize: desk ? 44 : 41, lineHeight: 0.98, letterSpacing: '-0.035em', marginTop: 6, overflowWrap: 'break-word' }}>{question}</div>
        <div style={{ fontSize: 14, fontWeight: 600, opacity: 0.65, marginTop: 8 }}>{card.sub}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginTop: 16 }}>
          <span style={{ fontSize: 13, fontWeight: 700, opacity: 0.65 }}>{card.clock.label}</span>
          <span style={{ ...display, fontSize: desk ? 40 : 36, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{card.clock.value}</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '14px 14px 0' }}>
        {card.sides.map((s) => (
          <div key={s.side} style={{ minWidth: 0, borderRadius: 22, background: s.side === 'yes' ? 'var(--mako-signal)' : 'var(--mako-red)', color: '#000', padding: 14 }}>
            <div style={{ ...display, fontSize: 20, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
            <div style={{ ...display, fontSize: s.pays ? 26 : 18, lineHeight: s.pays ? undefined : '31px', marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{s.pays ?? 'No stake yet'}</div>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, fontVariantNumeric: 'tabular-nums' }}>
              {s.amount} · {s.bettors} in
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 22px 20px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{card.scanTitle}</div>
          <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{linkDisplay(link)}</div>
          {card.minLine && <div style={{ fontSize: 12, opacity: 0.6, marginTop: 6 }}>{card.minLine}</div>}
        </div>
        <div style={{ flex: 'none', padding: 5, background: '#fff', borderRadius: 12 }}>
          <QRCodeSVG value={link} size={72} level="M" bgColor="#ffffff" fgColor="#000000" role="img" aria-label={`QR code for ${linkDisplay(link)}`} style={{ display: 'block' }} />
        </div>
      </div>
    </div>
  );
}

type TargetProps = { label: string; bg: string; fg: string; icon: React.ReactNode } & (
  | { href: string; name: string; onClick?: never; comingSoon?: never }
  | { onClick: () => void; name: string; href?: never; comingSoon?: never }
  | { comingSoon: true; href?: never; onClick?: never; name?: never }
);

/// One share target: a 54px round icon over its label, as the design draws them.
function Target({ label, bg, fg, icon, ...t }: TargetProps) {
  const item: React.CSSProperties = { flex: '0 1 auto', minWidth: 54, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'inherit', textDecoration: 'none', textAlign: 'center' };
  const circle = (
    <span aria-hidden="true" style={{ flex: 'none', width: 54, height: 54, borderRadius: 9999, background: bg, color: fg, boxShadow: 'var(--edge), inset 0 0 0 1px rgba(255,255,255,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {icon}
    </span>
  );
  if (t.comingSoon) {
    // The app's coming-soon pattern (ListActionButton): disabled, dimmed, "· coming soon" after the label.
    return (
      <button disabled aria-disabled="true" className="m3-press" style={{ ...item, opacity: 0.55, cursor: 'not-allowed' }}>
        {circle}
        <span style={{ maxWidth: 80 }}>{label} · coming soon</span>
      </button>
    );
  }
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

function SaveIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
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
