'use client';

import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Logo } from '@/components/Logo';
import { useUsdcBalance } from '@/lib/hooks';
import { useLivePrices } from '@/lib/use-live-prices';
import { activeNav, NAV } from '@/lib/shell-nav';
import { SignInLink } from '@/components/signin/SignInLink';
import { useTheme } from '@/lib/use-theme';
import { formatUsdc } from '@/lib/usdc';
import { accountAddress, useUser, type AuthedUser } from '@/lib/use-user';
import { formatAddress } from '@/lib/user-display';
import { openFeedback } from '@/lib/feedback-store';

import { pct2, usd2 } from './format';
import { ICON, StrokeIcon, SunIcon } from './icons';
import { BetaTag } from './BetaTag';
import { NotificationsPanel } from './NotificationsPanel';
import { SignOutConfirm } from './SignOutConfirm';
import { useDismiss } from './use-dismiss';

function BtcPrice() {
  const { live, unavailable } = useLivePrices();
  const btc = live?.prices.BTC;
  return (
    <span style={{ height: 40, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', fontFamily: 'var(--mako-font-mono)', fontSize: 13 }}>
      <span style={{ color: 'var(--dim)' }}>BTC</span>
      {btc ? (
        <>
          <span style={{ fontWeight: 700 }}>{usd2(btc.usd)}</span>
          {btc.change24h !== null && (
            <span style={{ color: btc.change24h < 0 ? 'var(--mako-red)' : 'var(--mako-accent)' }}>{pct2(btc.change24h)}</span>
          )}
        </>
      ) : (
        <span style={{ color: 'var(--dim)' }}>{unavailable ? 'unavailable' : '…'}</span>
      )}
    </span>
  );
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const btn = (which: 'light' | 'dark') => ({
    width: 32,
    height: 32,
    borderRadius: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: which === 'light' ? 'var(--tg-sun)' : 'var(--tg-moon)',
    color: which === 'light' ? 'var(--tg-sun-fg)' : 'var(--tg-moon-fg)',
    transition: 'background-color 200ms ease',
  });
  return (
    <div role="group" aria-label="Theme" style={{ flex: 'none', display: 'flex', gap: 2, padding: 3, borderRadius: 9999, boxShadow: 'inset 0 0 0 1px var(--line)' }}>
      <button aria-label="Light" aria-pressed={theme === 'light'} onClick={() => setTheme('light')} style={btn('light')}>
        <SunIcon />
      </button>
      <button aria-label="Dark" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')} style={btn('dark')}>
        <StrokeIcon d={ICON.moon} size={15} strokeWidth={2.5} />
      </button>
    </div>
  );
}

function Bell() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, wrap, close, trigger);
  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      <button
        ref={trigger}
        aria-label="Notifications"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        style={{ position: 'relative', flex: 'none', width: 40, height: 40, borderRadius: 9999, background: 'var(--raise)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <StrokeIcon d={ICON.bell} size={18} />
      </button>
      {open && <NotificationsPanel />}
    </div>
  );
}

function menuRow(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: '100%',
    height: 40,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '0 10px',
    borderRadius: 10,
    textAlign: 'left',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--mako-canvas-fg)',
    textDecoration: 'none',
    ...extra,
  };
}

function WalletMenu({ user, balance, onSignOut, onNavigate }: { user: AuthedUser; balance: string | null; onSignOut: () => void; onNavigate: () => void }) {
  const [copied, setCopied] = useState(false);
  const address = accountAddress(user);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the address stays visible to copy by hand.
    }
  };
  return (
    <div
      role="menu"
      aria-label="Wallet"
      className="mk-pop"
      style={{
        position: 'absolute',
        top: 46,
        right: 0,
        zIndex: 60,
        width: 260,
        boxSizing: 'border-box',
        borderRadius: 14,
        background: 'var(--mako-canvas)',
        boxShadow: 'var(--edge), inset 0 0 0 1px var(--line), 0 24px 60px rgba(0,0,0,.45)',
        padding: 8,
        textAlign: 'left',
        fontFamily: 'var(--mako-font-sans)',
        transformOrigin: 'top right',
      }}
    >
      <div style={{ padding: '8px 10px 10px', boxShadow: 'inset 0 -1px 0 var(--line)', marginBottom: 6 }}>
        <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 11, color: 'var(--dim)', letterSpacing: '.06em' }}>
          {user.authType === 'magic' ? 'SIGNED IN · EMAIL' : 'SIGNED IN · WALLET'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <span style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 13, fontWeight: 700 }} title={address}>
            {formatAddress(address)}
          </span>
          <button
            onClick={copy}
            style={{ marginLeft: 'auto', height: 26, padding: '0 10px', borderRadius: 9999, background: 'var(--raise2)', fontFamily: 'var(--mako-font-mono)', fontSize: 11, fontWeight: 700 }}
          >
            {copied ? 'COPIED' : 'COPY'}
          </button>
        </div>
        <div style={{ fontFamily: 'var(--mako-font-mono)', fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>
          {balance === null ? 'Balance unavailable' : `${balance} USDC`} · MONAD TESTNET
        </div>
      </div>
      <Link role="menuitem" href="/me" onClick={onNavigate} className="wm-row" style={menuRow()}>
        <StrokeIcon d={ICON.profile} />
        Profile
      </Link>
      <Link role="menuitem" href="/settings" onClick={onNavigate} className="wm-row" style={menuRow()}>
        <StrokeIcon d={ICON.settings} />
        Settings
      </Link>
      <Link role="menuitem" href="/?tour=1" onClick={onNavigate} className="wm-row" style={menuRow()}>
        <StrokeIcon d={ICON.help} />
        How to play
      </Link>
      <Link role="menuitem" href="/legal" onClick={onNavigate} className="wm-row" style={menuRow()}>
        <StrokeIcon d={ICON.legal} />
        Terms, privacy and risk
      </Link>
      <button
        role="menuitem"
        onClick={() => {
          onNavigate();
          openFeedback();
        }}
        className="wm-row"
        style={menuRow()}
      >
        <StrokeIcon d={ICON.feedback} />
        Feedback
      </button>
      <div style={{ height: 1, background: 'var(--line)', margin: '6px 4px' }} />
      <button role="menuitem" onClick={onSignOut} className="wm-row" style={menuRow({ fontWeight: 700, color: 'var(--mako-red)' })}>
        <StrokeIcon d={ICON.signOut} />
        Sign out
      </button>
    </div>
  );
}

function Wallet({ user }: { user: AuthedUser }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, wrap, close, trigger);
  const balanceQuery = useUsdcBalance(accountAddress(user));
  const balance = typeof balanceQuery.data === 'bigint' ? formatUsdc(balanceQuery.data) : null;
  return (
    <span
      ref={wrap}
      style={{ position: 'relative', height: 40, display: 'flex', alignItems: 'center', gap: 12, padding: '0 0 0 12px', boxShadow: 'inset 1px 0 0 var(--line)', fontFamily: 'var(--mako-font-mono)', fontSize: 13, fontWeight: 700 }}
    >
      {balance === null ? <span style={{ color: 'var(--dim)', fontWeight: 500 }}>{balanceQuery.isError ? 'Balance unavailable' : '…'}</span> : `${balance} USDC`}
      <button
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ height: 30, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', fontWeight: 500, fontSize: 12, boxShadow: 'var(--edge)' }}
      >
        {formatAddress(accountAddress(user))}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" style={{ marginLeft: 6 }} aria-hidden="true">
          <path d={ICON.chevronDown} />
        </svg>
      </button>
      {open && (
        <WalletMenu
          user={user}
          balance={balance}
          onNavigate={close}
          onSignOut={() => {
            setOpen(false);
            setConfirming(true);
          }}
        />
      )}
      {confirming && <SignOutConfirm user={user} onClose={() => setConfirming(false)} />}
    </span>
  );
}

/// The desktop header (2a): logo, the four destinations, live BTC price, theme switch, and the account.
export function DesktopHeader() {
  const active = activeNav(usePathname() ?? '/');
  const { user, isLoading } = useUser();
  return (
    <header style={{ height: 68, display: 'flex', alignItems: 'center', gap: 28 }}>
      <Link href="/" aria-label="Mako Market Beta home" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'inherit', textDecoration: 'none' }}>
        <Logo size={28} />
        <span style={{ fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 20, letterSpacing: '-0.03em' }}>Mako Market</span>
        <BetaTag />
      </Link>
      <nav aria-label="Main" style={{ display: 'flex', gap: 2, padding: 4, borderRadius: 9999, background: 'var(--raise)' }}>
        {NAV.map((n) => {
          const on = n.key === active;
          return (
            <Link
              key={n.key}
              href={n.href}
              aria-current={on ? 'page' : undefined}
              style={{
                height: 36,
                display: 'flex',
                alignItems: 'center',
                padding: '0 16px',
                borderRadius: 9999,
                fontFamily: 'var(--mako-font-display)',
                fontWeight: 800,
                fontSize: 15,
                textDecoration: 'none',
                background: on ? 'var(--mako-canvas-fg)' : 'transparent',
                color: on ? 'var(--mako-canvas)' : 'var(--dim)',
                transition: 'background-color 200ms ease',
              }}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <BtcPrice />
        <ThemeSwitch />
        {user ? (
          <>
            <Bell />
            <Wallet user={user} />
          </>
        ) : isLoading ? null : (
          <SignInLink
            className="mk-press97"
            style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 20px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 15, textDecoration: 'none' }}
          >
            Sign in
          </SignInLink>
        )}
      </div>
    </header>
  );
}
