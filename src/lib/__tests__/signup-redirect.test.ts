// /signup is retired (Codex S4 r1): it sends every visitor to /signin, where the dialog shows the first-sign-in beta
// notice, and keeps the query string so campaign tags (utm_*) survive.

import { describe, expect, it, vi } from 'vitest';

const redirect = vi.hoisted(() =>
  vi.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
);
vi.mock('next/navigation', () => ({ redirect }));

import SignupPage from '@/app/signup/page';

describe('/signup', () => {
  it('redirects to /signin', async () => {
    await expect(SignupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /signin');
  });
  it('keeps the query string, repeated keys included', async () => {
    await expect(SignupPage({ searchParams: Promise.resolve({ utm_source: 'x', utm_campaign: 'launch', a: ['1', '2'] }) })).rejects.toThrow(
      'REDIRECT /signin?utm_source=x&utm_campaign=launch&a=1&a=2',
    );
  });
});
