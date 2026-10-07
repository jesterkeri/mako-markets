// Adversary on 89b5058. Spec (owner decision, 2026-10-07): "On mobile there is no Home page: / sends the visitor to
// /pools, keeping the query string; a desktop window is never sent away." A desktop window that opens / and is then
// narrowed below the desktop breakpoint (or a tablet rotated from landscape to portrait) is now a mobile window on /:
// the mobile slot renders nothing, so it must be sent to /pools rather than left on an empty mobile Home.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), useSearchParams: () => new URLSearchParams(window.location.search) }));

import { MobileGoesToPools } from '@/app/_home/HomeClient';

/// A window whose width can change: matchMedia answers against `desktop`, and every listener (the MediaQueryList
/// 'change' event, the older addListener API, and window 'resize') hears the change.
function resizableWindow(startDesktop: boolean) {
  let desktop = startDesktop;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      get matches() {
        return q === '(min-width: 1024px)' ? desktop : false;
      },
      media: q,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      addListener: (l: () => void) => listeners.add(l),
      removeListener: (l: () => void) => listeners.delete(l),
    }),
  });
  return {
    narrowToPhone() {
      desktop = false;
      for (const l of [...listeners]) l();
      window.dispatchEvent(new Event('resize'));
    },
  };
}

afterEach(() => {
  cleanup();
  replace.mockClear();
  window.history.replaceState(null, '', '/');
});

describe('/ in a window that crosses from desktop to mobile width', () => {
  it('stays while desktop, then is sent to /pools (query kept) once the window is a mobile one', () => {
    window.history.replaceState(null, '', '/?tour=1');
    const win = resizableWindow(true);
    act(() => {
      render(<MobileGoesToPools />);
    });
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      win.narrowToPhone();
    });
    expect(replace).toHaveBeenCalledWith('/pools?tour=1');
  });
});
