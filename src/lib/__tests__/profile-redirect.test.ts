// /profile is retired: it redirects to /wallet, where sending and receiving now live.

import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

import ProfilePage from '@/app/profile/page';

describe('/profile', () => {
  it('redirects to /wallet', () => {
    expect(() => ProfilePage()).toThrow('NEXT_REDIRECT /wallet');
    expect(redirect).toHaveBeenCalledWith('/wallet');
  });
});
