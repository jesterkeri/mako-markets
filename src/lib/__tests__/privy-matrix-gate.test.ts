// The Privy test-matrix page is served only by `next dev`: production runs with MAKO_STAGE=dev, so the stage gate the
// other /dev pages use would not keep it out.

import { afterEach, describe, expect, it, vi } from 'vitest';

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ notFound: () => notFound() }));
vi.mock('@/app/dev/privy-matrix/Harness', () => ({ PrivyMatrixHarness: () => null }));

import DevPrivyMatrixPage from '@/app/dev/privy-matrix/page';

afterEach(() => vi.unstubAllEnvs());

describe('/dev/privy-matrix', () => {
  it('answers not found in a production build, even with MAKO_STAGE=dev', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MAKO_STAGE', 'dev');
    expect(() => DevPrivyMatrixPage()).toThrow('NEXT_NOT_FOUND');
  });

  it('renders under next dev', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(() => DevPrivyMatrixPage()).not.toThrow();
  });
});
