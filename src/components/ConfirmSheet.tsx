'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { explorerUrl } from '@/lib/chain';
import { useFocusTrap } from '@/lib/use-focus-trap';
import { formatAddress } from '@/lib/user-display';

// Confirm in wallet (19a): the one sheet every on-chain action goes through (enter a round, bet on a pool,
// claim, create a pool). A dialog on desktop, a bottom sheet on mobile (yellow in dark mode). The flow that opens
// it owns the phase, so the sheet only ever shows what the real transaction is doing.

export type ConfirmRow = { label: string; value: string; tone?: 'up' | 'no' };

export type ConfirmSpec = {
  /// The round glyph and its colour: ▲ / ▼ for rounds, Y / N for pools, $ for claims, + for create.
  glyph: string;
  glyphColor: string;
  title: string;
  confirmLabel: string;
  pendingTitle: string;
  rows: ConfirmRow[];
  note: string;
  doneTitle: string;
  doneBody: string;
  /// The second button once done ("Share round", "View in Me").
  doneSecondary?: { label: string; href: string };
};

export type ConfirmAction = { label: string; href?: string; retry?: true };

export type ConfirmPhase =
  | { step: 'review' }
  /// signing: waiting for the signature; sending: signed, going to Monad; confirming: sent, waiting for a block.
  | { step: 'pending'; stage: 'signing' | 'sending' | 'confirming'; txHash?: string }
  | { step: 'done'; txHash?: string }
  | { step: 'cancelled' }
  | {
      step: 'failed';
      title: string;
      body: string;
      /// True only when the flow knows no USDC moved (reverted or never sent). Unknown outcomes stay false.
      nothingMoved: boolean;
      primary: ConfirmAction;
      secondary: ConfirmAction;
    };

type Props = {
  spec: ConfirmSpec;
  phase: ConfirmPhase;
  /// The signing wallet: the email account's Mako wallet (gas sponsored) or the user's own wallet.
  wallet: { kind: 'mako' | 'external'; address: string };
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
};

const WALLET_ICON = 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5v10A2.5 2.5 0 0 0 6.5 20H20v-4M4 7.5A2.5 2.5 0 0 0 6.5 10H20v3M16 13h4v3h-4a1.5 1.5 0 0 1 0-3z';
export const CLOSE_ICON = 'M6.5 6.5l11 11M17.5 6.5l-11 11';
export const CHECK_ICON = 'M5 12.5l4.5 4.5L19 7.5';
export const WARN_ICON = 'M12 4l9 16H3zM12 10v4M12 17v.1';

export function Svg({ d, size }: { d: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Spinner({ size }: { size: number }) {
  return (
    <svg className="wl-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/// The sheet's pill buttons: yellow primary, tinted secondary.
export const sheetButton = (primary: boolean): React.CSSProperties => ({
  flex: 1,
  height: 54,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 16px',
  whiteSpace: 'nowrap',
  borderRadius: 9999,
  background: primary ? 'var(--mako-signal)' : 'var(--raise2)',
  color: primary ? '#000' : 'var(--mako-canvas-fg)',
  boxShadow: primary ? 'var(--edge)' : 'none',
  fontSize: 16,
  fontWeight: 800,
  textDecoration: 'none',
});

function ActionButton({ action, primary, onRetry, onClose }: { action: ConfirmAction; primary: boolean; onRetry: () => void; onClose: () => void }) {
  if (action.href) {
    return (
      <Link href={action.href} onClick={onClose} className={primary ? 'm3-press mk-onsig' : 'm3-press'} style={sheetButton(primary)}>
        {action.label}
      </Link>
    );
  }
  return (
    <button onClick={action.retry ? onRetry : onClose} className={primary ? 'm3-press mk-onsig' : 'm3-press'} style={sheetButton(primary)}>
      {action.label}
    </button>
  );
}

export const tileTitle: React.CSSProperties = { fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 30, lineHeight: 1.02, letterSpacing: '-0.025em' };
export const tileBody: React.CSSProperties = { fontSize: 15, lineHeight: 1.45, fontWeight: 600, opacity: 0.8, marginTop: 6 };
const chip: React.CSSProperties = { alignSelf: 'flex-start', height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', borderRadius: 9999, background: 'color-mix(in srgb, currentColor 14%, transparent)', fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'inherit', textDecoration: 'none' };

function Body({ spec, phase, wallet, onConfirm, onCancel, onRetry, onClose, variant, confirmRef }: Props & { variant: 'desktop' | 'mobile'; confirmRef: React.RefObject<HTMLButtonElement | null> }) {
  const rows: ConfirmRow[] = [...spec.rows];
  const feeText = wallet.kind === 'mako' ? 'Free · gas covered' : 'Paid in MON by your wallet';
  const titleSize = variant === 'desktop' ? 32 : 30;
  const pending = phase.step === 'pending';
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Svg d={WALLET_ICON} size={16} />
          {wallet.kind === 'mako' ? 'Mako wallet' : 'Your wallet'} · {formatAddress(wallet.address)}
        </span>
        {!pending && (
          <button onClick={onClose} aria-label="Close" className="m3-press" style={{ width: 40, height: 40, borderRadius: 9999, background: variant === 'desktop' ? 'var(--raise)' : 'var(--raise2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Svg d={CLOSE_ICON} size={16} />
          </button>
        )}
      </div>

      {phase.step === 'review' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ flex: 'none', width: 56, height: 56, borderRadius: 9999, background: spec.glyphColor, color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="mk-onsig" style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 22 }}>{spec.glyph}</span>
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="wl-eyebrow" style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>Confirm to continue</div>
              <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: titleSize, lineHeight: 1.05, letterSpacing: '-0.02em' }}>{spec.title}</div>
            </div>
          </div>
          <div className="wl-tbl" style={{ borderRadius: 20, background: 'var(--raise)', padding: '4px 16px' }}>
            {[...rows.map((r) => ({ ...r, fee: false })), { label: 'Network fee', value: feeText, fee: true, tone: undefined }].map((r) => (
              <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
                <span className="wl-k" style={{ fontSize: 14, fontWeight: 600, color: 'var(--dim)' }}>{r.label}</span>
                <span
                  className="wl-v"
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: r.fee && wallet.kind === 'mako' ? 'var(--m3-inv-fg)' : r.tone === 'up' ? 'var(--up-text)' : r.tone === 'no' ? 'var(--mako-red)' : 'var(--mako-canvas-fg)',
                    background: r.fee && wallet.kind === 'mako' ? 'var(--m3-inv)' : 'transparent',
                    padding: r.fee && wallet.kind === 'mako' ? '5px 12px' : 0,
                    borderRadius: 9999,
                  }}
                >
                  {r.value}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--dim)' }}>{spec.note}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onCancel} className="m3-press" style={{ ...sheetButton(false), flex: 'none', width: 112 }}>
              Cancel
            </button>
            <button ref={confirmRef} onClick={onConfirm} className="m3-press mk-onsig" style={sheetButton(true)}>
              {spec.confirmLabel}
            </button>
          </div>
        </>
      )}

      {phase.step === 'pending' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ flex: 'none', width: 56, height: 56, borderRadius: 9999, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spinner size={28} />
            </span>
            <div>
              <div className="wl-eyebrow" style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>Don’t close this</div>
              <div role="status" style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: titleSize, lineHeight: 1.05, letterSpacing: '-0.02em' }}>{spec.pendingTitle}</div>
            </div>
          </div>
          <div className="wl-tbl" style={{ borderRadius: 20, background: 'var(--raise)', padding: '6px 16px' }}>
            {(
              [
                ['Signed', phase.stage === 'signing' ? 'now' : 'done', ''],
                ['Sent to Monad', phase.stage === 'signing' ? 'wait' : phase.stage === 'sending' ? 'now' : 'done', phase.txHash ? formatAddress(phase.txHash) : ''],
                ['Confirmed', phase.stage === 'confirming' ? 'now' : 'wait', ''],
              ] as const
            ).map(([label, state, meta]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0', boxShadow: 'inset 0 -1px 0 var(--line)' }}>
                <span style={{ flex: 'none', width: 26, height: 26, borderRadius: 9999, background: state === 'done' ? 'var(--mako-teal)' : 'var(--raise2)', color: state === 'done' ? '#000' : 'var(--mako-canvas-fg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {state === 'done' && <Svg d={CHECK_ICON} size={14} />}
                  {state === 'now' && <Spinner size={16} />}
                </span>
                <span style={{ fontSize: 15, fontWeight: 700, color: state === 'wait' ? 'var(--dim)' : 'var(--mako-canvas-fg)' }}>{label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>{meta}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--dim)' }}>Usually a few seconds on Monad.</div>
        </>
      )}

      {phase.step === 'done' && (
        <>
          <div className="wl-tile" style={{ borderRadius: 28, background: 'var(--m3-inv)', color: 'var(--m3-inv-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: 9999, background: 'var(--m3-inv-fg)', color: 'var(--m3-inv)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CHECK_ICON} size={26} />
            </span>
            <div role="status">
              <div style={tileTitle}>{spec.doneTitle}</div>
              <div style={tileBody}>{spec.doneBody}</div>
            </div>
            {phase.txHash && (
              <a href={explorerUrl('tx', phase.txHash)} target="_blank" rel="noopener noreferrer" style={chip}>
                Transaction · {formatAddress(phase.txHash)} ↗
              </a>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            {spec.doneSecondary && <ActionButton action={spec.doneSecondary} primary={false} onRetry={onRetry} onClose={onClose} />}
            <button ref={confirmRef} onClick={onClose} className="m3-press mk-onsig" style={sheetButton(true)}>
              Done
            </button>
          </div>
        </>
      )}

      {phase.step === 'cancelled' && (
        <>
          <div className="wl-tile" style={{ borderRadius: 28, background: 'var(--raise2)', color: 'var(--mako-canvas-fg)', boxShadow: 'var(--edge)', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: 9999, background: 'var(--mako-canvas-fg)', color: 'var(--mako-canvas)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={CLOSE_ICON} size={24} />
            </span>
            <div role="status">
              <div style={tileTitle}>You cancelled</div>
              <div style={tileBody}>Nothing was sent. Your balance hasn’t changed.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} className="m3-press" style={sheetButton(false)}>
              Close
            </button>
            <button ref={confirmRef} onClick={onRetry} className="m3-press mk-onsig" style={sheetButton(true)}>
              Try again
            </button>
          </div>
        </>
      )}

      {phase.step === 'failed' && (
        <>
          <div role="alert" className="wl-tile" style={{ borderRadius: 28, background: 'var(--mako-red)', color: '#000', boxShadow: 'inset 0 0 0 2px #000', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span style={{ width: 52, height: 52, borderRadius: 9999, background: '#000', color: 'var(--mako-red)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Svg d={WARN_ICON} size={24} />
            </span>
            <div>
              <div style={tileTitle}>{phase.title}</div>
              <div style={tileBody}>{phase.body}</div>
            </div>
            {phase.nothingMoved && (
              <div style={chip}>
                <Svg d={CHECK_ICON} size={14} />
                No USDC left your wallet
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <ActionButton action={phase.secondary} primary={false} onRetry={onRetry} onClose={onClose} />
            <ActionButton action={phase.primary} primary onRetry={onRetry} onClose={onClose} />
          </div>
        </>
      )}
    </>
  );
}

/// The confirm-in-wallet sheet. Render it while an action is open; the parent owns `phase`.
export function ConfirmSheet(props: Props) {
  const desktopConfirm = useRef<HTMLButtonElement>(null);
  const mobileConfirm = useRef<HTMLButtonElement>(null);
  const pending = props.phase.step === 'pending';
  const { onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, onClose]);

  // Keyboard focus lands on the main action of each state.
  useEffect(() => {
    (window.matchMedia('(min-width: 1024px)').matches ? desktopConfirm : mobileConfirm).current?.focus();
  }, [props.phase.step]);

  return (
    <SheetFrame label="Confirm in wallet" onScrim={pending ? undefined : onClose} initialFocus={{ desktop: desktopConfirm, mobile: mobileConfirm }}>
      {(variant) => <Body {...props} variant={variant} confirmRef={variant === 'desktop' ? desktopConfirm : mobileConfirm} />}
    </SheetFrame>
  );
}

/// The frame every redesigned action sheet shares (19a): a dialog on desktop, a bottom sheet on mobile (yellow in
/// dark mode), over one scrim. The content renders once per layout; CSS shows one of the two.
export function SheetFrame({
  label,
  onScrim,
  initialFocus,
  children,
}: {
  label: string;
  onScrim?: () => void;
  /// What takes focus when the sheet opens, per variant (else its first focusable control).
  initialFocus?: { desktop: React.RefObject<HTMLElement | null>; mobile: React.RefObject<HTMLElement | null> };
  children: (variant: 'desktop' | 'mobile') => React.ReactNode;
}) {
  const deskRef = useRef<HTMLDivElement>(null);
  const mobRef = useRef<HTMLDivElement>(null);
  // Both variants render; Tab is kept inside the visible one, and focus returns to the opener on close.
  const [desktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  useFocusTrap({ open: desktop, containerRef: deskRef, initialFocusRef: initialFocus?.desktop });
  useFocusTrap({ open: !desktop, containerRef: mobRef, initialFocusRef: initialFocus?.mobile });
  return (
    <>
      <div className="mk-scrim" onClick={onScrim} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={deskRef}
        className="wl-dlg mk-desk mk-pop"
        style={{
          position: 'fixed',
          top: 96,
          left: '50%',
          marginLeft: -230,
          width: 460,
          boxSizing: 'border-box',
          borderRadius: 24,
          zIndex: 81,
          background: 'var(--mako-canvas)',
          color: 'var(--mako-canvas-fg)',
          boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 40px 100px rgba(0,0,0,0.5)',
          padding: '18px 22px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {children('desktop')}
      </div>
      <div className="mk-mob mk-m" style={{ position: 'fixed', inset: 0, zIndex: 81, pointerEvents: 'none' }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label}
          ref={mobRef}
          className="mk-sheet mk-ysheet"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'auto',
            borderRadius: '32px 32px 0 0',
            background: 'var(--mako-canvas)',
            color: 'var(--mako-canvas-fg)',
            boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 -20px 60px rgba(0,0,0,0.4)',
            padding: '10px 16px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 9999, background: 'var(--m3-outline)', alignSelf: 'center' }} />
          {children('mobile')}
        </div>
      </div>
    </>
  );
}
