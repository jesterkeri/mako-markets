// The confirm sheet's 30 s hold on a new pool's times (naming plan r8 §7.7, §8): the chain gets exactly the title and
// times the sheet showed, built from the moment it opened, and a Confirm more than SHEET_HOLD_SEC later is refused
// with "Times moved on" before any allowance read, signature or send, on both the gas-free path and the wallet path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Hex } from 'viem';

const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const WALLET = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const TX = ('0x' + '11'.repeat(32)) as Hex;
const OPENED = 1_800_000_000; // the second the sheet opened (nowSec)

const magicUser = {
  authed: true,
  authType: 'magic',
  email: 'a@b.c',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: SAFE,
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};
const walletUser = { authed: true, authType: 'wallet', walletAddress: WALLET, displayName: null, avatarUrl: null, lastSignInAt: null };

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  connected: undefined as string | undefined,
  allowance: 10n ** 30n,
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContractAsync: vi.fn(),
  runSponsoredRequest: vi.fn(),
  buildCreateBody: vi.fn(),
}));

vi.mock('../use-user', async () => {
  const actual = await vi.importActual<typeof import('../use-user')>('../use-user');
  return { ...actual, useUser: () => ({ user: mocks.user, isLoading: false }) };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.connected }),
  useChainId: () => 10143,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContractAsync }),
  usePublicClient: () => ({
    readContract: mocks.readContract,
    simulateContract: mocks.simulateContract,
    waitForTransactionReceipt: mocks.waitForTransactionReceipt,
  }),
}));

vi.mock('../hooks', () => ({ useEnsureMonadChain: () => async () => undefined }));

vi.mock('../aa-client', async () => {
  const actual = await vi.importActual<typeof import('../aa-client')>('../aa-client');
  return {
    ...actual,
    runSponsoredRequest: (...args: unknown[]) => mocks.runSponsoredRequest(...args),
    buildCreateBody: (args: Parameters<typeof actual.buildCreateBody>[0]) => {
      mocks.buildCreateBody(args);
      return actual.buildCreateBody(args);
    },
  };
});

import { buildPool, type CreateDraft } from '../pool-create';
import { usePoolTx } from '../use-pool-tx';

const draft: CreateDraft = { kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 100000, durationSec: 300 };
const shown = buildPool(draft, OPENED);
if (!shown.ok) throw new Error(shown.reason);

let clock = OPENED;
let mono = OPENED; // the monotonic clock, in seconds (performance.now() / 1000)
function setClock(sec: number) {
  clock = sec;
  mono = sec;
}

function setup(user: 'magic' | 'wallet') {
  vi.spyOn(Date, 'now').mockImplementation(() => clock * 1000);
  vi.spyOn(performance, 'now').mockImplementation(() => mono * 1000);
  mocks.user = user === 'magic' ? magicUser : walletUser;
  mocks.connected = user === 'wallet' ? WALLET : undefined;
  mocks.readContract.mockImplementation(async () => mocks.allowance);
  mocks.simulateContract.mockResolvedValue({});
  mocks.writeContractAsync.mockResolvedValue(TX);
  mocks.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [], transactionHash: TX });
  mocks.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: TX, userOpHash: TX });
  const hook = renderHook(() => usePoolTx());
  setClock(OPENED);
  act(() => hook.result.current.open({ kind: 'create', draft, nowSec: OPENED, openedAtMs: OPENED * 1000, seed: 1_000_000n, seedYes: true }));
  return hook;
}

async function confirm(hook: ReturnType<typeof setup>, at: number, how: 'confirm' | 'retry' = 'confirm', wallAt = at) {
  setClock(at);
  clock = wallAt; // a device clock moved by hand: the wall clock alone changes
  await act(async () => {
    await hook.result.current[how]();
  });
  return hook.result.current.phase;
}

const movedOn = {
  step: 'failed',
  title: 'Times moved on',
  body: "A new pool's times are set when this sheet opens and hold for 30 seconds. Close this and press Create pool again for new times.",
  nothingMoved: true,
  primary: { label: 'Close' },
  secondary: { label: 'Close' },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const f of [mocks.readContract, mocks.simulateContract, mocks.waitForTransactionReceipt, mocks.writeContractAsync, mocks.runSponsoredRequest, mocks.buildCreateBody]) f.mockReset();
  mocks.allowance = 10n ** 30n;
});

describe('email account (gas-free)', () => {
  it('31 s after the sheet opened: refused, nothing read, signed or sent', async () => {
    const hook = setup('magic');
    expect(await confirm(hook, OPENED + 31)).toEqual(movedOn);
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.buildCreateBody).not.toHaveBeenCalled();
    expect(mocks.runSponsoredRequest).not.toHaveBeenCalled();
  });

  it('at 30 s: sends exactly the title and times the sheet showed', async () => {
    const hook = setup('magic');
    expect((await confirm(hook, OPENED + 30)).step).toBe('done');
    expect(mocks.runSponsoredRequest).toHaveBeenCalledTimes(1);
    expect(mocks.buildCreateBody).toHaveBeenCalledWith(expect.objectContaining({ question: shown.pool.question, closeTime: shown.pool.closeTime, bettingCloseTime: shown.pool.bettingCloseTime }));
  });

  it('"Try again" after a nothing-moved failure: the same times within the hold, "Times moved on" after it', async () => {
    const hook = setup('magic');
    mocks.runSponsoredRequest.mockResolvedValueOnce({ kind: 'expired' });
    const failed = await confirm(hook, OPENED);
    expect(failed).toMatchObject({ step: 'failed', nothingMoved: true, primary: { retry: true } });
    expect((await confirm(hook, OPENED + 30, 'retry')).step).toBe('done');
    expect(mocks.buildCreateBody).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.buildCreateBody.mock.calls) expect(args).toMatchObject({ question: shown.pool.question, closeTime: shown.pool.closeTime });

    const late = setup('magic');
    mocks.runSponsoredRequest.mockReset();
    mocks.readContract.mockClear();
    mocks.buildCreateBody.mockClear();
    mocks.runSponsoredRequest.mockResolvedValueOnce({ kind: 'expired' });
    await confirm(late, OPENED);
    const reads = mocks.readContract.mock.calls.length;
    expect(await confirm(late, OPENED + 31, 'retry')).toEqual(movedOn);
    expect(mocks.readContract).toHaveBeenCalledTimes(reads);
    expect(mocks.buildCreateBody).toHaveBeenCalledTimes(1);
    expect(mocks.runSponsoredRequest).toHaveBeenCalledTimes(1);
  });

  it('a device clock moved back: 100 s after opening, the wall clock reads only 5 s later; refused, nothing read, signed or sent (Codex R1 F2)', async () => {
    const hook = setup('magic');
    expect(await confirm(hook, OPENED + 100, 'confirm', OPENED + 5)).toEqual(movedOn);
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.buildCreateBody).not.toHaveBeenCalled();
    expect(mocks.runSponsoredRequest).not.toHaveBeenCalled();
  });
});

describe('wallet account', () => {
  it('31 s after the sheet opened: refused, nothing read, simulated, signed or sent', async () => {
    const hook = setup('wallet');
    expect(await confirm(hook, OPENED + 31)).toEqual(movedOn);
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });

  it('at 30 s: simulates and sends the times the sheet showed', async () => {
    const hook = setup('wallet');
    expect((await confirm(hook, OPENED + 30)).step).toBe('done');
    const sent = mocks.writeContractAsync.mock.calls.map(([r]) => r).find((r) => r.functionName === 'createMarket');
    expect(sent.args[2]).toBe(shown.pool.bettingCloseTime);
    expect(sent.args[3]).toBe(shown.pool.closeTime);
    expect(sent.args[4]).toBe(shown.pool.question);
  });

  it('a hold that runs out while the approval confirms is refused before the simulation', async () => {
    mocks.allowance = 0n;
    const hook = setup('wallet');
    // The approval's receipt arrives 6 s after a Confirm at 29 s.
    mocks.waitForTransactionReceipt.mockImplementation(async () => {
      setClock(OPENED + 35);
      return { status: 'success', logs: [], transactionHash: TX };
    });
    const phase = await confirm(hook, OPENED + 29);
    expect(mocks.writeContractAsync).toHaveBeenCalledTimes(1);
    expect(mocks.writeContractAsync.mock.calls[0][0].functionName).toBe('approve');
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    // The approval landed and is kept (it moves no USDC); the sheet says the pool was not placed, and why.
    expect(phase).toMatchObject({ step: 'failed', nothingMoved: true });
    expect((phase as { body: string }).body).toContain('hold for 30 seconds');
  });

  it('a device clock moved back: 100 s after opening, the wall clock reads only 5 s later; refused, nothing read, simulated or sent (Codex R1 F2)', async () => {
    const hook = setup('wallet');
    expect(await confirm(hook, OPENED + 100, 'confirm', OPENED + 5)).toEqual(movedOn);
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.simulateContract).not.toHaveBeenCalled();
    expect(mocks.writeContractAsync).not.toHaveBeenCalled();
  });
});
