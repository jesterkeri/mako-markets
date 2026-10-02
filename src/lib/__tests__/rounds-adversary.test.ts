// Adversary tests for the gas-free Rounds actions (spec mako-design/REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md).
// Each test names the spec rule it holds the code to.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, pad, toHex, type Address, type Hex } from 'viem';

const ROUNDS = vi.hoisted(() => {
  const address = '0x5e0f1e7b7a3b1c2d3E4F5a6b7c8D9E0f1A2B3C4d';
  process.env.NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS = address;
  return address as `0x${string}`;
});

// Rounds is live only for a reviewed release record (Codex S2 r1): this file supplies one for ROUNDS, and the
// on-chain identity check passes (its own tests are in rounds-release.test.ts).
vi.mock('@/lib/rounds-release-record', async () => {
  const { USDC_ADDRESS } = await import('@/lib/usdc');
  return { ROUNDS_RELEASE_RECORD: { address: ROUNDS, runtimeCodeHash: `0x${'11'.repeat(32)}`, usdc: USDC_ADDRESS } };
});
vi.mock('@/lib/rounds-release', () => ({ assertRoundsRelease: vi.fn(async () => {}), resetRoundsReleaseCache: vi.fn() }));

const mocks = vi.hoisted(() => ({ signSafeOpHash: vi.fn() }));
vi.mock('../embedded-signer', () => ({ signSafeOpHash: (a: unknown) => mocks.signSafeOpHash(a) }));

import { assertSponsoredCallData, NotAllowedError } from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { ROUND_SCHEDULE_SELECTOR } from '../rounds-call-allowlist';
import { runClaimRound } from '../rounds-client';
import { encodeSingleExecuteUserOpCallData } from '../user-op';

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const EOA: Address = '0x000000000000000000000000000000000000ee0a';

describe('spec "Browser": stages signing, sending, confirming', () => {
  const sponsored = {
    pendingUserOpId: '00000000-0000-0000-0000-00000000aaaa',
    safeOpHash: '0x' + 'aa'.repeat(32),
    userOpHash: '0x' + 'bb'.repeat(32),
    validAfter: '0x0',
    validUntil: '0xffffffffffff',
  };
  const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    mocks.signSafeOpHash.mockResolvedValue(('0x' + '11'.repeat(77)) as Hex);
    // The send route accepted the op and handed it to the bundler; it is on its way, waiting for a block.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).endsWith('/api/aa/sponsor') ? res(200, sponsored) : res(200, { status: 'submitted', userOpHash: sponsored.userOpHash }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.signSafeOpHash.mockReset();
  });

  it('a run whose op was submitted and awaits a block reports the confirming stage to the confirm sheet', async () => {
    const stages: string[] = [];
    const out = await runClaimRound({ chainId: MONAD_TESTNET_ID, magicEoa: EOA, roundsAddress: ROUNDS, roundId: 9n, onStage: (s) => stages.push(s) });
    expect(out.kind).toBe('submitted');
    expect(stages).toContain('confirming');
  });
});

describe('spec rule 2/6: a send-time Rounds call must decode as schedule(uint64)', () => {
  it('refuses schedule whose startTime word does not fit uint64 (the contract ABI decoder reverts on it)', async () => {
    // 15 * 2^64 is a multiple of 60 (2^64 is divisible by 4) but is not a uint64.
    const startWord = pad(toHex(15n << 64n), { size: 32 });
    const data = concat([ROUND_SCHEDULE_SELECTOR, startWord]);
    const callData = encodeSingleExecuteUserOpCallData({ to: ROUNDS, value: 0n, data });
    await expect(assertSponsoredCallData({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, callData })).rejects.toBeInstanceOf(NotAllowedError);
  });
});
