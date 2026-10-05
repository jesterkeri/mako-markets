// /dev pages must not render on production, which runs with MAKO_STAGE=dev (/dev/aa-smoke answered 200 on
// makomarket.xyz on 2026-10-05). devPagesAllowed is the shared gate; aa-smoke is checked through its real page.

import { afterEach, describe, expect, it, vi } from 'vitest';

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('@/app/dev/aa-smoke/AaSmokeClient', () => ({ AaSmokeClient: () => null }));

import { devPagesAllowed } from '@/lib/dev-pages';
import DevAaSmokePage from '@/app/dev/aa-smoke/page';

afterEach(() => vi.unstubAllEnvs());

describe('devPagesAllowed', () => {
  it('refuses the production deployment even with MAKO_STAGE=dev', () => {
    expect(devPagesAllowed({ MAKO_STAGE: 'dev', VERCEL_ENV: 'production', NODE_ENV: 'production' })).toBe(false);
  });
  it('allows a preview deployment and local dev with MAKO_STAGE=dev', () => {
    expect(devPagesAllowed({ MAKO_STAGE: 'dev', VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(true);
    expect(devPagesAllowed({ MAKO_STAGE: 'dev', NODE_ENV: 'development' })).toBe(true);
  });
  it('refuses a production build outside Vercel, and any stage other than dev', () => {
    expect(devPagesAllowed({ MAKO_STAGE: 'dev', NODE_ENV: 'production' })).toBe(false);
    expect(devPagesAllowed({ MAKO_STAGE: 'beta', VERCEL_ENV: 'preview' })).toBe(false);
  });
});

describe('/dev/aa-smoke', () => {
  it('answers not found on the production deployment', () => {
    vi.stubEnv('MAKO_STAGE', 'dev');
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(() => DevAaSmokePage()).toThrow('NEXT_NOT_FOUND');
  });
});
