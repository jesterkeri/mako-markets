'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '@/lib/use-focus-trap';
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
  const { signOut, retry, leave, busy, error, leftover } = useSignOut();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const cancelMobileRef = useRef<HTMLButtonElement>(null);
  const deskRef = useRef<HTMLDivElement>(null);
  const mobRef = useRef<HTMLDivElement>(null);
  // Both variants render; the trap (Tab stays inside, focus returns to the opener on close) goes on the visible one.
  const [desktop] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches);
  useFocusTrap({ open: desktop, containerRef: deskRef, initialFocusRef: cancelRef });
  useFocusTrap({ open: !desktop, containerRef: mobRef, initialFocusRef: cancelMobileRef });

  // Once Mako's session has ended, closing means leaving signed out; before that, it means cancelling.
  const dismiss = useCallback(() => {
    if (busy) return;
    if (leftover) leave();
    onClose();
  }, [busy, leftover, leave, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const desktopLine =
    user.authType === 'magic'
      ? `Your wallet, balance and bets stay as they are. Sign back in with ${maskEmail(user.email)}.`
      : 'Your wallet, balance and bets stay as they are. Sign back in with the same wallet.';
  const mobileLine =
    user.authType === 'magic'
      ? 'Your wallet, balance and bets stay as they are. Sign back in with the same email.'
      : 'Your wallet, balance and bets stay as they are. Sign back in with the same wallet.';
  const confirm = async () => {
    if (await (leftover ? retry() : signOut())) onClose();
  };
  const unfinished = leftover
    ? `You're signed out of Mako Market, but ${
        leftover.privy && leftover.wallet ? 'the email sign-in and your wallet did' : leftover.privy ? 'the email sign-in did' : 'your wallet did'
      } not finish signing out in this browser. Try again, or continue and close this tab.`
    : null;
  const title = leftover ? 'Almost signed out' : 'Sign out?';
  const errorLine = error ? (
    <div role="alert" style={{ fontSize: 14, fontWeight: 700, color: 'var(--mako-red)' }}>
      {error}
    </div>
  ) : null;

  return (
    <>
      <div
        className="mk-scrim"
        onClick={busy ? undefined : dismiss}
        style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}
      />
      {/* Desktop */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sign out"
        ref={deskRef}
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
        <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 26, letterSpacing: '-0.02em' }}>{title}</div>
        <div role={unfinished ? 'alert' : undefined} style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)', marginTop: 8 }}>
          {unfinished ?? desktopLine}
        </div>
        {errorLine && <div style={{ marginTop: 10 }}>{errorLine}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            ref={cancelRef}
            onClick={dismiss}
            disabled={busy}
            style={{ flex: 'none', width: 112, height: 50, borderRadius: 9999, background: 'var(--raise2)', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15 }}
          >
            {leftover ? 'Continue' : 'Cancel'}
          </button>
          <button
            onClick={confirm}
            disabled={busy}
            style={{ flex: 1, height: 50, borderRadius: 9999, background: 'var(--mako-red)', color: '#000', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15 }}
          >
            {busy ? 'Signing out…' : leftover ? 'Try again' : 'Sign out'}
          </button>
        </div>
      </div>
      {/* Mobile */}
      <div className="mk-mob mk-m" style={{ position: 'fixed', inset: 0, zIndex: 81, pointerEvents: 'none' }}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sign out"
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
            boxShadow: 'var(--edge), 0 -20px 60px rgba(0,0,0,.4)',
            padding: '10px 16px 28px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 9999, background: 'var(--m3-outline)', alignSelf: 'center' }} />
          <div style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 28, letterSpacing: '-0.02em' }}>{title}</div>
          <div role={unfinished ? 'alert' : undefined} style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--dim)' }}>
            {unfinished ?? mobileLine}
          </div>
          {errorLine}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              ref={cancelMobileRef}
              onClick={dismiss}
              disabled={busy}
              className="m3-press"
              style={{ flex: 'none', width: 112, height: 54, borderRadius: 9999, background: 'var(--raise2)', fontSize: 16, fontWeight: 800 }}
            >
              {leftover ? 'Continue' : 'Cancel'}
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className="m3-press"
              style={{ flex: 1, height: 54, borderRadius: 9999, background: 'var(--mako-red)', color: '#000', boxShadow: 'var(--edge)', fontSize: 16, fontWeight: 800 }}
            >
              {busy ? 'Signing out…' : leftover ? 'Try again' : 'Sign out'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
