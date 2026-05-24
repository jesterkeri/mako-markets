// Regression test for the prod incident where Vercel's env value for
// NEXT_PUBLIC_MAKO_ADDRESS had a trailing newline, was inlined into
// the client bundle as "0xbC5A...26195\n", and viem rejected it as
// malformed — collapsing every chain read to undefined and rendering
// the home feed as "No open markets yet."
//
// `src/lib/contract.ts` calls `normalizeAddress(raw, label)` (private
// module helper) on env values before exporting. Test the observable
// behavior: re-import `src/lib/contract.ts` after mutating
// `process.env.NEXT_PUBLIC_MAKO_ADDRESS` and assert the exported
// `MAKO_ADDRESS` matches the trimmed, EIP-55-checksummed form.

import { afterEach, describe, expect, it, vi } from 'vitest';

const LIVE_V4 = '0xbC5A58487D7949dA2B76aC84AfC032fD0aa26195';

async function importContractWithEnv(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.NEXT_PUBLIC_MAKO_ADDRESS;
  else process.env.NEXT_PUBLIC_MAKO_ADDRESS = value;
  return import('@/lib/contract');
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_MAKO_ADDRESS;
  vi.resetModules();
});

describe('MAKO_ADDRESS env normalization', () => {
  it('falls back to the live v4 address when env is unset', async () => {
    const { MAKO_ADDRESS } = await importContractWithEnv(undefined);
    expect(MAKO_ADDRESS).toBe(LIVE_V4);
  });

  it('trims trailing newline from env (the prod regression)', async () => {
    const { MAKO_ADDRESS } = await importContractWithEnv(`${LIVE_V4}\n`);
    expect(MAKO_ADDRESS).toBe(LIVE_V4);
  });

  it('trims leading/trailing whitespace from env', async () => {
    const { MAKO_ADDRESS } = await importContractWithEnv(`  ${LIVE_V4}  `);
    expect(MAKO_ADDRESS).toBe(LIVE_V4);
  });

  it('accepts lowercased env value, returns EIP-55 checksummed', async () => {
    const { MAKO_ADDRESS } = await importContractWithEnv(LIVE_V4.toLowerCase());
    expect(MAKO_ADDRESS).toBe(LIVE_V4);
  });

  it('throws at module load if env value is not a valid address', async () => {
    await expect(importContractWithEnv('not-an-address')).rejects.toThrow(
      /NEXT_PUBLIC_MAKO_ADDRESS is not a valid address/,
    );
  });
});
