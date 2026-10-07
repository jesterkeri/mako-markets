// Mobile has no Home page (Joshua, 2026-10-07): / sends a phone to Pools; a desktop stays on its Home page.
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

import { MobileGoesToPools } from '@/app/_home/HomeClient';

function setWidth(desktop: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({ matches: q === '(min-width: 1024px)' ? desktop : false, media: q, addEventListener() {}, removeEventListener() {} }),
  });
}

afterEach(() => {
  replace.mockClear();
  window.history.replaceState(null, '', '/');
});

describe('the / route on a phone and on a desktop', () => {
  it('a phone is sent to /pools', () => {
    setWidth(false);
    act(() => {
      render(<MobileGoesToPools />);
    });
    expect(replace).toHaveBeenCalledWith('/pools');
  });

  it('keeps the query, so the tour opened on / still shows on Pools', () => {
    setWidth(false);
    window.history.replaceState(null, '', '/?tour=1');
    act(() => {
      render(<MobileGoesToPools />);
    });
    expect(replace).toHaveBeenCalledWith('/pools?tour=1');
  });

  it('a desktop is never sent away', () => {
    setWidth(true);
    act(() => {
      render(<MobileGoesToPools />);
    });
    expect(replace).not.toHaveBeenCalled();
  });
});
