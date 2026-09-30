// Browser side of the gas-free Rounds actions: the right kind and calldata, approve only when needed, stages in
// order, and nothing sent while Rounds is not live.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

const mocks = vi.hoisted(() => ({ signSafeOpHash: vi.fn() }));
vi.mock('../embedded-signer', () => ({ signSafeOpHash: (a: unknown) => mocks.signSafeOpHash(a) }));

import { MONAD_TESTNET_ID } from '../chain';
import { roundsAbi } from '../rounds-abi';
import { runClaimRound, runEnterRound, runRefundRound, runScheduleRound } from '../rounds-client';
import { USDC_ADDRESS } from '../usdc';

const ROUNDS: Address = '0x5e0f1e7b7a3b1c2d3E4F5a6b7c8D9E0f1A2B3C4d';
const EOA: Address = '0x000000000000000000000000000000000000ee0a';
const SIG = ('0x' + '11'.repeat(77)) as Hex;
const TX = ('0x' + 'cc'.repeat(32)) as Hex;

const sponsored = {
  pendingUserOpId: '00000000-0000-0000-0000-00000000aaaa',
  safeOpHash: '0x' + 'aa'.repeat(32),
  userOpHash: '0x' + 'bb'.repeat(32),
  validAfter: '0x0',
  validUntil: '0xffffffffffff',
};
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

let bodies: unknown[] = [];
beforeEach(() => {
  bodies = [];
  mocks.signSafeOpHash.mockResolvedValue(SIG);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    bodies.push(JSON.parse(String((init as RequestInit).body)));
    return String(url).endsWith('/api/aa/sponsor') ? res(200, sponsored) : res(200, { status: 'sent', txHash: TX, userOpHash: sponsored.userOpHash });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.signSafeOpHash.mockReset();
});

const base = { chainId: MONAD_TESTNET_ID, magicEoa: EOA, roundsAddress: ROUNDS };
const sponsorBody = () => bodies[0] as { kind: string; call?: { to: Address; data: Hex }; calls?: { to: Address; data: Hex }[] };

describe('runEnterRound', () => {
  it('with enough allowance sends one round_enter call: enter(round, Up=1, amount) on ROUNDS', async () => {
    const out = await runEnterRound({ ...base, roundId: 142n, side: 'up', amount: 5_000_000n, currentAllowance: 5_000_000n });
    expect(out).toMatchObject({ kind: 'sent', txHash: TX });
    const b = sponsorBody();
    expect(b.kind).toBe('round_enter');
    expect(b.call!.to).toBe(ROUNDS);
    expect(decodeFunctionData({ abi: roundsAbi, data: b.call!.data })).toMatchObject({ functionName: 'enter', args: [142n, 1, 5_000_000n] });
  });

  it('below the stake it approves first: [approve(ROUNDS, MaxUint256) on USDC, enter(Down=2)]', async () => {
    await runEnterRound({ ...base, roundId: 7n, side: 'down', amount: 1_000_000n, currentAllowance: 999_999n });
    const b = sponsorBody();
    expect(b.kind).toBe('round_enter_batched');
    expect(b.calls!.map((c) => c.to)).toEqual([USDC_ADDRESS, ROUNDS]);
    expect(decodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }], data: b.calls![0].data }).args).toEqual([ROUNDS, maxUint256]);
    expect(decodeFunctionData({ abi: roundsAbi, data: b.calls![1].data }).args).toEqual([7n, 2, 1_000_000n]);
  });

  it('reports signing, then sending', async () => {
    const stages: string[] = [];
    await runEnterRound({ ...base, roundId: 1n, side: 'up', amount: 100_000n, currentAllowance: 0n, onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['signing', 'sending']);
  });
});

describe('claim, refund and schedule', () => {
  it.each([
    ['round_claim', () => runClaimRound({ ...base, roundId: 9n }), 'claim', [9n]],
    ['round_refund', () => runRefundRound({ ...base, roundId: 9n }), 'finalizeRefund', [9n]],
    ['round_schedule', () => runScheduleRound({ ...base, startTime: 1_790_000_640n }), 'schedule', [1_790_000_640n]],
  ] as const)('%s sends its function on ROUNDS', async (kind, run, fn, args) => {
    await run();
    const b = sponsorBody();
    expect(b.kind).toBe(kind);
    expect(b.call!.to).toBe(ROUNDS);
    expect(decodeFunctionData({ abi: roundsAbi, data: b.call!.data })).toMatchObject({ functionName: fn, args });
  });
});

describe('Rounds not live', () => {
  it('every action answers rounds_unavailable without any request or signature', async () => {
    const off = { chainId: MONAD_TESTNET_ID, magicEoa: EOA, roundsAddress: null };
    const outs = await Promise.all([
      runEnterRound({ ...off, roundId: 1n, side: 'up', amount: 100_000n, currentAllowance: 0n }),
      runClaimRound({ ...off, roundId: 1n }),
      runRefundRound({ ...off, roundId: 1n }),
      runScheduleRound({ ...off, startTime: 60n }),
    ]);
    for (const o of outs) expect(o).toEqual({ kind: 'sponsor_failed', status: 0, error: 'rounds_unavailable' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.signSafeOpHash).not.toHaveBeenCalled();
  });
});
