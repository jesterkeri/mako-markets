'use client';

import { useEffect, useRef } from 'react';

import { useSignOut } from '@/lib/use-sign-out';
import type { AuthedUser } from '@/lib/use-user';

/// "joshua@gmail.com" -> "joshua@…mail.com": enough to recognise, not the whole address on screen.
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const domain = email.slice(at + 1);
  return domain.length > 8 ? `${email.slice(0, at)}@…${domain.slice(-8)}` : email;
}

type Props = { user: AuthedUser; onClose: () => void };

/// The sign-out confirm (21a): a dialog on desktop, a bottom sheet on mobile (yellow in dark mode).
export function SignOutConfirm({ user, onClose }: Props) {
  const { signOut, busy, error } = useSignOut();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelMobileRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    (window.matchMedia('(min-width: 1024px)').matches ? cancelRef : cancelMobileRef).current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const desktopLine =
    user.authType === 'magic'
      ? `Your wallet, balance and bets stay as they are. Sign back in with ${maskEmail(user.email)}.`
      : 'Your wallet, balance and bets stay as they are. Sign back in with the same wallet.';
  const mobileLine =
    user.authType === 'magic'
      ? 'Your wallet, balance and bets stay as they are. Sign back in with the same email.'
      : 'Your wallet, balance and bets stay as they are. Sign back in with the same wallet.';
  const confirm = async () => {
    if (await signOut()) onClose();
  };
  const errorLine = error ? (
    <div role="alert" style={{ fontSize: 14, fontWeight: 700, color: 'var(--mako-red)' }}>
      {error}
    </div>
  ) : null;

  return (
    <>
      <div
        className="mk-scrim"
        onClick={busy ? undefined : onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
      />
      {/* Desktop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign out"
        className="mk-desk mk-pop"
        style={{
          position: 'fixed',
          top: 160,
          left: '50%',
          marginLeft: -200,
          width: 400,
          boxSizing: 'border-box',
          zIndex: 81,
          borderRadius: 16,
          background: 'var(--mako-canvas)',
          color: 'var(--mako-canvas-fg)',
          boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 40px 100px rgba(0,0,0,.5)',
          padding: 22,
        }}
      >
        <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em' }}>Sign out?</div>
        <div style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', marginTop: 8 }}>{desktopLine}</div>
        {errorLine && <div style={{ marginTop: 10 }}>{errorLine}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            ref={cancelRef}
            onClick={onClose}
            disabled={busy}
            style={{ flex: 'none', width: 112, height: 50, borderRadius: 9999, background: 'var(--raise2)', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15 }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{ flex: 1, height: 50, borderRadius: 9999, background: 'var(--mako-red)', color: '#000', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15 }}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
      {/* Mobile */}
      <div className="mk-mob mk-m" style={{ position: 'fixed', inset: 0, zIndex: 81, pointerEvents: 'none' }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sign out"
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
            boxShadow: 'var(--edge), 0 -20px 60px rgba(0,0,0,.4)',
            padding: '10px 16px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 9999, background: 'var(--m3-outline)', alignSelf: 'center' }} />
          <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 28, letterSpacing: '-0.02em' }}>Sign out?</div>
          <div style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' }}>{mobileLine}</div>
          {errorLine}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              ref={cancelMobileRef}
              onClick={onClose}
              disabled={busy}
              className="m3-press"
              style={{ flex: 'none', width: 112, height: 54, borderRadius: 9999, background: 'var(--raise2)', fontSize: 16, fontWeight: 800 }}
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className="m3-press"
              style={{ flex: 1, height: 54, borderRadius: 9999, background: 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800 }}
            >
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
