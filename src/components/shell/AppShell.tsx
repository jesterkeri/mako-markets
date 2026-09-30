'use client';

import { usePathname } from 'next/navigation';

import { SignInDialog } from '@/components/signin/SignInDialog';
import { isMobileDetail } from '@/lib/shell-nav';
import { DesktopHeader } from './DesktopHeader';
import { MobileHeader } from './MobileHeader';
import { StatusStrip } from './StatusStrip';
import { TabBar } from './TabBar';

/// The redesign's chrome around every page: desktop header and status strip from 1024px, mobile header and tab
/// bar below it. The page itself renders once, in <main>; pages lay themselves out per width with the
/// `.mk-desk` / `.mk-mob` classes.
export function AppShell({ children }: { children: React.ReactNode }) {
  const detail = isMobileDetail(usePathname() ?? '');
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: 'var(--mako-canvas)', color: 'var(--mako-canvas-fg)', fontFamily: 'var(--mako-font-sans)' }}>
      <div className="mk-desk mk-desk-frame">
        <DesktopHeader />
      </div>
      {!detail && (
        <div className="mk-mob mk-m">
          <MobileHeader />
        </div>
      )}
      <main className={detail ? undefined : 'mk-main'} style={{ flex: 1, minWidth: 0 }}>
        {children}
      </main>
      <div className="mk-desk mk-desk-frame" style={{ paddingBottom: 24 }}>
        <StatusStrip />
      </div>
      {!detail && (
        <div className="mk-mob mk-m">
          <TabBar />
        </div>
      )}
      <SignInDialog />
    </div>
  );
}
