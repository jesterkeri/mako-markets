// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/treasury.test.ts
//
// Tests for getPmTreasuryAddress + __resetPmTreasuryCache. Mocks the
// @/lib/aa-public-client module so we control readContract's behaviour
// per test (happy / RPC-failure / mismatch / RPC-recovery-no-retry).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadContract = vi.fn();

vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    readContract: mockReadContract,
  }),
}));

import {
  __resetPmTreasuryCache,
  getPmTreasuryAddress,
} from '../treasury';

const TREASURY_CHAIN = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const;
const TREASURY_CHAIN_LOWER = TREASURY_CHAIN.toLowerCase();
const TREASURY_ENV = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb' as const;
const TREASURY_ENV_LOWER = TREASURY_ENV.toLowerCase();

beforeEach(() => {
  __resetPmTreasuryCache();
  mockReadContract.mockReset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  __resetPmTreasuryCache();
  vi.unstubAllEnvs();
});

describe('getPmTreasuryAddress — happy path', () => {
  it('reads from chain once; subsequent calls hit the cache', async () => {
    mockReadContract.mockResolvedValue(TREASURY_CHAIN);
    const first = await getPmTreasuryAddress();
    const second = await getPmTreasuryAddress();
    expect(first).toBe(TREASURY_CHAIN_LOWER);
    expect(second).toBe(TREASURY_CHAIN_LOWER);
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });
});

describe('getPmTreasuryAddress — RPC failure + env fallback', () => {
  it('falls back to PRIVATE_MARKETS_TREASURY env (lowercased) on RPC reject', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PRIVATE_MARKETS_TREASURY', TREASURY_ENV);
    mockReadContract.mockRejectedValue(new Error('rpc 500'));
    const result = await getPmTreasuryAddress();
    expect(result).toBe(TREASURY_ENV_LOWER);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});

describe('getPmTreasuryAddress — RPC failure + no env', () => {
  it('re-throws; subsequent call retries the RPC (inFlight cleared)', async () => {
    vi.stubEnv('PRIVATE_MARKETS_TREASURY', '');
    mockReadContract.mockRejectedValueOnce(new Error('rpc 500'));
    await expect(getPmTreasuryAddress()).rejects.toThrow('rpc 500');
    // Now the RPC "recovers" — the next call should hit it again
    // (inFlight cleared in finally so we don't stay stuck on the
    // rejected promise forever).
    mockReadContract.mockResolvedValueOnce(TREASURY_CHAIN);
    const recovered = await getPmTreasuryAddress();
    expect(recovered).toBe(TREASURY_CHAIN_LOWER);
    expect(mockReadContract).toHaveBeenCalledTimes(2);
  });
});

describe('getPmTreasuryAddress — env/chain mismatch', () => {
  it('throws config-drift error when env differs from chain', async () => {
    vi.stubEnv('PRIVATE_MARKETS_TREASURY', TREASURY_ENV);
    mockReadContract.mockResolvedValue(TREASURY_CHAIN);
    await expect(getPmTreasuryAddress()).rejects.toThrow(
      /PRIVATE_MARKETS_TREASURY mismatch/,
    );
  });
});

describe('getPmTreasuryAddress — env-fallback cache permanence (Codex r3 MIN-2)', () => {
  it('caches env on RPC failure; later RPC recovery does NOT re-read', async () => {
    // Codex r4 MIN-1: explicitly reset at the start so prior cached
    // state can't make this test pass for the wrong reason.
    __resetPmTreasuryCache();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('PRIVATE_MARKETS_TREASURY', TREASURY_ENV);
    mockReadContract.mockRejectedValueOnce(new Error('rpc 500'));

    const first = await getPmTreasuryAddress();
    expect(first).toBe(TREASURY_ENV_LOWER);
    expect(mockReadContract).toHaveBeenCalledTimes(1);

    // RPC "recovers" — but we don't re-read. The cache holds the env
    // value for the process lifetime; operator must restart to refresh.
    mockReadContract.mockResolvedValueOnce(TREASURY_CHAIN);
    const second = await getPmTreasuryAddress();
    expect(second).toBe(TREASURY_ENV_LOWER); // still env
    expect(mockReadContract).toHaveBeenCalledTimes(1); // no second RPC

    warnSpy.mockRestore();
  });
});
