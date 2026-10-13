// The page behind an open sign-in sheet must not scroll (tester's phone recording, 2026-10-13). usePageScrollLock locks
// <html> and <body>, keeps them locked while any lock is held, and restores the exact prior values.
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { usePageScrollLock } from '@/lib/use-page-scroll-lock';

afterEach(() => {
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe('usePageScrollLock', () => {
  it('locks html and body while mounted and restores what was there before', () => {
    document.body.style.overflow = 'scroll';
    const h = renderHook(() => usePageScrollLock());
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
    h.unmount();
    expect(document.documentElement.style.overflow).toBe('');
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('two layers: the page stays locked until the last one closes', () => {
    const a = renderHook(() => usePageScrollLock());
    const b = renderHook(() => usePageScrollLock());
    a.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    b.unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('inactive: touches nothing', () => {
    renderHook(() => usePageScrollLock(false));
    expect(document.body.style.overflow).toBe('');
  });
});

describe('the sign-in dialog locks the page while open', () => {
  it('the mobile sheet contains its own overscroll and the backdrop takes no touch scrolling', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/components/signin/SignInDialog.tsx', 'utf8'));
    expect(src).toMatch(/function MobileSheet\(p: FlowProps\) \{\n  usePageScrollLock\(\);/);
    expect(src).toMatch(/function DesktopDialog\(p: FlowProps\) \{\n  usePageScrollLock\(\);/);
    expect(src).toMatch(/overflowY: 'auto', overscrollBehavior: 'contain'/);
    expect(src).toMatch(/background: 'rgba\(0,0,0,0\.55\)', touchAction: 'none'/);
  });
});
