// The 404 page's "Still in the water" list (7a): a chain read that failed, or came back partial, is shown as an
// error with a retry, never as "Nothing is open right now".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

const state = vi.hoisted(() => ({ markets: [] as unknown[], count: 0, isLoading: false, isError: false, refetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/hooks', () => ({ useMarkets: () => state }));
vi.mock('@/lib/use-live-clock', () => ({ useLiveNowSec: () => 1_790_000_000 }));

import { StillInTheWaterDesktop, StillInTheWaterMobile } from '@/components/StillInTheWater';

afterEach(() => {
  cleanup();
  Object.assign(state, { markets: [], count: 0, isLoading: false, isError: false });
  state.refetch.mockReset();
});

describe('Still in the water', () => {
  it('a failed chain read shows the error and a working retry, not an empty list', () => {
    Object.assign(state, { isError: true });
    render(
      <>
        <StillInTheWaterDesktop />
        <StillInTheWaterMobile />
      </>,
    );
    expect(screen.queryAllByText('Nothing is open right now.')).toHaveLength(0);
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('a partial read (fewer markets than the count) is an error too', () => {
    Object.assign(state, { count: 3, markets: [] });
    render(<StillInTheWaterDesktop />);
    expect(screen.queryAllByText('Nothing is open right now.')).toHaveLength(0);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('a complete read with nothing open says so', () => {
    Object.assign(state, { count: 0, markets: [] });
    render(<StillInTheWaterDesktop />);
    expect(screen.getByText('Nothing is open right now.')).toBeTruthy();
  });
});
