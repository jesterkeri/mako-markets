// Rounds is live only for the reviewed release record, and only while the chain still shows it (Codex S2 r1): a
// syntactically valid Rounds address is not a contract identity.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address } from 'viem';

import { NotAllowedError } from '@/lib/aa-call-allowlist';
import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS, resolveRoundsAddress, type RoundsRelease } from '@/lib/contract';
import { assertRoundsRelease, resetRoundsReleaseCache, type ReleaseReader } from '@/lib/rounds-release';
import { USDC_ADDRESS } from '@/lib/usdc';

const ROUNDS: Address = '0x4444444444444444444444444444444444444444';
const CODE = '0x6080604052348015600f57600080fd5b50' as const;
const RELEASE: RoundsRelease = { address: ROUNDS, runtimeCodeHash: keccak256(CODE), usdc: USDC_ADDRESS.trim() as Address };

function reader(over: Partial<{ code: `0x${string}` | undefined; usdc: Address; fail: boolean }> = {}): ReleaseReader & { calls: number } {
  const r = {
    calls: 0,
    async getBytecode() {
      r.calls += 1;
      if (over.fail) throw new Error('rpc down');
      return 'code' in over ? over.code : CODE;
    },
    async readUsdc() {
      if (over.fail) throw new Error('rpc down');
      return over.usdc ?? RELEASE.usdc;
    },
  };
  return r;
}
async function reasonOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof NotAllowedError ? `${e.reason}${e.detail ? `:${e.detail}` : ''}` : `other:${String(e)}`;
  }
}

afterEach(() => resetRoundsReleaseCache());

describe('resolveRoundsAddress: the environment address must be the reviewed release', () => {
  const others = [MAKO_ADDRESS, PM_CONTRACT_ADDRESS, USDC_ADDRESS];
  it('with no release record, a valid address still leaves Rounds off', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRoundsAddress(ROUNDS, others, null)).toBeNull();
  });
  it('a different valid address than the record leaves Rounds off', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveRoundsAddress('0x5555555555555555555555555555555555555555', others, RELEASE)).toBeNull();
  });
  it('the recorded address, in any case, turns Rounds on', () => {
    expect(resolveRoundsAddress(ROUNDS.toUpperCase().replace('0X', '0x'), others, RELEASE)?.toLowerCase()).toBe(ROUNDS);
  });
  it('the shipped record is the verified 2026-10-06 deployment (cross-checked against its receipt in CI)', async () => {
    const { ROUNDS_RELEASE_RECORD } = await import('@/lib/rounds-release-record');
    expect(ROUNDS_RELEASE_RECORD).toEqual({
      address: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
      runtimeCodeHash: '0x2b39edd6d2bf8218c4a09c7a1bac643a1693879cd2bd61076d51d69f412770f9',
      usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    });
  });
});

describe('assertRoundsRelease: the chain must show the reviewed code and USDC', () => {
  it('passes for the recorded code and USDC, and remembers the match', async () => {
    const r = reader();
    expect(await reasonOf(assertRoundsRelease(RELEASE, r))).toBeNull();
    expect(await reasonOf(assertRoundsRelease(RELEASE, r))).toBeNull();
    expect(r.calls).toBe(1);
  });
  it.each([
    ['no release record', null, reader(), 'round_unavailable'],
    ['different runtime code', RELEASE, reader({ code: '0x6080604052' }), 'round_unavailable:code_hash'],
    ['no code at the address', RELEASE, reader({ code: undefined }), 'round_unavailable:code_hash'],
    ['empty code', RELEASE, reader({ code: '0x' }), 'round_unavailable:code_hash'],
    ['a different USDC immutable', RELEASE, reader({ usdc: '0x6666666666666666666666666666666666666666' }), 'round_unavailable:usdc'],
    ['an unreadable chain', RELEASE, reader({ fail: true }), 'round_unavailable:identity_unreadable'],
    ['a record whose USDC is not the configured USDC', { ...RELEASE, usdc: '0x7777777777777777777777777777777777777777' as Address }, reader(), 'round_unavailable:usdc_config'],
  ] as const)('refuses %s', async (_name, release, r, want) => {
    expect(await reasonOf(assertRoundsRelease(release, r))).toBe(want);
  });
  it('a failed check is not remembered: the next call reads again', async () => {
    const bad = reader({ fail: true });
    await reasonOf(assertRoundsRelease(RELEASE, bad));
    const good = reader();
    expect(await reasonOf(assertRoundsRelease(RELEASE, good))).toBeNull();
    expect(good.calls).toBe(1);
  });
});
