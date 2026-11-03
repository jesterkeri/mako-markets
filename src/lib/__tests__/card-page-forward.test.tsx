// A shared card link lands the visitor on the pool the bet was in, with the link's share tags (Joshua 2026-10-24).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const { ForwardToPool } = await import('@/app/pools/[id]/pnl/[tx]/[log]/[state]/ForwardToPool');

afterEach(() => {
  cleanup();
  replace.mockReset();
  window.history.replaceState(null, '', '/');
});

describe('a shared card forwards to its pool', () => {
  it('goes to the pool page with the link’s query', () => {
    window.history.replaceState(null, '', '/pools/7/pnl/0xabc/0/placed?utm_source=x&utm_campaign=pool-7');
    render(<ForwardToPool id="7" />);
    expect(replace).toHaveBeenCalledWith('/pools/7?utm_source=x&utm_campaign=pool-7');
  });

  it('goes to the pool page when the link has no query', () => {
    window.history.replaceState(null, '', '/pools/7/pnl/0xabc/0/result');
    render(<ForwardToPool id="7" />);
    expect(replace).toHaveBeenCalledWith('/pools/7');
  });
});
