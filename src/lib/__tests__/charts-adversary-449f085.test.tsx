// @vitest-environment jsdom
// Adversary pass on 449f085 (cb71ae1..449f085).
//
// On a phone, a page error on a pool, round or chart route now brings back the site's tab bar (error.tsx), but the
// tab bar is position: fixed over the bottom of the screen (TabBar.tsx: bottom calc(18px + safe area), height 60, a
// 120px gradient under it). Every other phone page gets room under its content for it from the shell's <main
// className="mk-main"> (mako-shell.css: "mobile pages leave room for the floating tab bar", padding-bottom
// calc(130px + env(safe-area-inset-bottom)) below 1024px). AppShell drops that class on isMobileDetail routes,
// because the pool and round pages size their own bottom room; the error page that replaces them reserves none, so
// its last controls ("Browse Pools", the Reference line) end up under the tab bar it just brought back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('@/components/shell/MobileHeader', () => ({ MobileHeader: () => <div data-testid="site-mobile-header" /> }));
vi.mock('@/components/shell/TabBar', () => ({ TabBar: () => <div data-testid="site-tab-bar" /> }));
vi.mock('@/components/shell/DesktopHeader', () => ({ DesktopHeader: () => <div data-testid="site-desktop-header" /> }));
vi.mock('@/components/shell/StatusStrip', () => ({ StatusStrip: () => null }));
vi.mock('@/components/shell/FeedbackButton', () => ({ FeedbackButton: () => null }));
vi.mock('@/components/shell/HowToPlay', () => ({ HowToPlay: () => null }));
vi.mock('@/components/shell/RefCapture', () => ({ RefCapture: () => null }));
vi.mock('@/components/shell/SignOutHost', () => ({ SignOutHost: () => null }));
vi.mock('@/components/signin/SignInDialog', () => ({ SignInDialog: () => null }));
vi.mock('@/components/FeedbackSheet', () => ({ FeedbackSheet: () => null }));
vi.mock('@/components/Mascot', () => ({ Mascot: () => null }));

import { AppShell } from '@/components/shell/AppShell';
import ErrorPage from '@/app/error';

afterEach(() => {
  cleanup();
});

const ZERO = new Set(['', '0', '0px']);

/// Whether anything between `el` and the shell reserves room below it for the fixed tab bar: the shell's own
/// `mk-main` class, or a non-zero bottom padding or margin on an ancestor, or a spacer after it.
function hasRoomBelow(el: HTMLElement, root: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && n !== root.parentElement; n = n.parentElement) {
    if (n.classList.contains('mk-main')) return true;
    if (!ZERO.has(n.style.paddingBottom) || !ZERO.has(n.style.marginBottom)) return true;
    // A spacer after the content, inside the same phone layout, counts too.
    for (let s = n.nextElementSibling as HTMLElement | null; s; s = s.nextElementSibling as HTMLElement | null) {
      if (s.dataset.testid === 'site-tab-bar') continue;
      if (!ZERO.has(s.style.height) || !ZERO.has(s.style.minHeight)) return true;
    }
  }
  return false;
}

function mobileBrowsePools(container: HTMLElement): HTMLElement {
  const mob = container.querySelector('main .mk-mob') as HTMLElement;
  const link = Array.from(mob.querySelectorAll('a')).find((a) => a.textContent === 'Browse Pools');
  if (!link) throw new Error('no phone Browse Pools link');
  return link as HTMLElement;
}

describe('a page error on a phone leaves room for the tab bar it shows', () => {
  it('control: on /pools the shell leaves room under the error for its tab bar', () => {
    nav.pathname = '/pools';
    const { container, getAllByTestId } = render(
      <AppShell>
        <ErrorPage error={Object.assign(new Error('x'), { digest: '123' })} unstable_retry={() => {}} />
      </AppShell>,
    );
    expect(getAllByTestId('site-tab-bar')).toHaveLength(1);
    expect(hasRoomBelow(mobileBrowsePools(container), container)).toBe(true);
  });

  it.each(['/pools/7', '/rounds/42', '/pools/7/chart', '/rounds/42/chart'])('%s: Browse Pools is not left under the fixed tab bar', (path) => {
    nav.pathname = path;
    const { container, getAllByTestId } = render(
      <AppShell>
        <ErrorPage error={Object.assign(new Error('x'), { digest: '123' })} unstable_retry={() => {}} />
      </AppShell>,
    );
    // The tab bar is there exactly once (the change under test).
    expect(getAllByTestId('site-tab-bar')).toHaveLength(1);
    // ...but nothing reserves the room under the error's last controls that every other phone page gets.
    expect(hasRoomBelow(mobileBrowsePools(container), container)).toBe(true);
  });
});
