'use client';

import Link from 'next/link';

import { Logo } from '@/components/Logo';
import { useUsdcBalance } from '@/lib/hooks';
import { SIGN_IN_HREF } from '@/lib/shell-nav';
import { formatUsdc } from '@/lib/usdc';
import { useUser } from '@/lib/use-user';

import { accountAddress } from './DesktopHeader';
import { ICON, StrokeIcon } from './icons';

const roundButton: React.CSSProperties = {
  flex: 'none',
  width: 44,
  height: 44,
  borderRadius: 9999,
  background: 'var(--raise)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--mako-canvas-fg)',
};

type Props = {
  /// Opens in-page search. Absent until search exists, so the button never does nothing.
  onSearch?: () => void;
};

/// The mobile header (2a): logo, search, notifications, balance. No theme switch on mobile (it lives in
/// Settings > Appearance).
export function MobileHeader({ onSearch }: Props) {
  const { user, isLoading } = useUser();
  const balanceQuery = useUsdcBalance(user ? accountAddress(user) : undefined);
  const balance = typeof balanceQuery.data === 'bigint' ? formatUsdc(balanceQuery.data) : null;
  return (
    <header style={{ height: 68, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 0 20px' }}>
      <Link href="/" aria-label="Mako Market home" style={{ display: 'flex', color: 'inherit' }}>
        <Logo size={28} />
      </Link>
      <span style={{ marginLeft: 'auto' }} />
      {onSearch && (
        <button onClick={onSearch} aria-label="Search" className="m3-press" style={roundButton}>
          <StrokeIcon d={ICON.search} size={18} />
        </button>
      )}
      {user ? (
        <>
          <Link href="/notifications" aria-label="Notifications" className="m3-press" style={roundButton}>
            <StrokeIcon d={ICON.bell} size={20} />
          </Link>
          <Link
            href="/me"
            aria-label="Balance"
            style={{ height: 44, display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px 0 8px', borderRadius: 9999, background: 'var(--raise)', fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--mako-canvas-fg)', textDecoration: 'none' }}
          >
            <span style={{ width: 28, height: 28, borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800 }}>
              $
            </span>
            {balance ?? (balanceQuery.isError ? 'Unavailable' : '…')}
          </Link>
        </>
      ) : isLoading ? null : (
        <Link
          href={SIGN_IN_HREF}
          className="m3-press"
          style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 20px', borderRadius: 9999, background: 'var(--mako-signal)', color: '#000', boxShadow: 'var(--edge)', fontSize: 15, fontWeight: 800, textDecoration: 'none' }}
        >
          Sign in
        </Link>
      )}
    </header>
  );
}
