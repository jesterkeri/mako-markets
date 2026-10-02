// /api/aa/sponsor for the gas-free Rounds kinds, with Rounds live (spec REDESIGN_S2_ROUNDS_SPONSOR_SPEC.md).
// Only the edges are mocked (session, DB, limiter, builder, chain reads); the route and validators are real.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

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

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
  insertPending: vi.fn(),
  incrementOrReject: vi.fn(),
  decrementForRefund: vi.fn(),
  buildSponsoredUserOp: vi.fn(),
  getBlock: vi.fn(),
  readContract: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: () => mocks.getUserSession() }));
vi.mock('@/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.selectFromUserSafes() }) }) }) },
}));
vi.mock('@/lib/aa-pending-user-ops', () => ({
  loadInFlightForSafe: (a: unknown) => mocks.loadInFlightForSafe(a),
  insertPending: (a: unknown) => mocks.insertPending(a),
}));
vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: (a: unknown) => mocks.incrementOrReject(a),
  decrementForRefund: (a: unknown) => mocks.decrementForRefund(a),
}));
vi.mock('@/lib/user-op', async (importActual) => ({ ...(await importActual<typeof import('../user-op')>()), buildSponsoredUserOp: (a: unknown) => mocks.buildSponsoredUserOp(a) }));
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({ getBlock: (a: unknown) => mocks.getBlock(a), readContract: (a: unknown) => mocks.readContract(a) }),
}));

import { POST } from '../../app/api/aa/sponsor/route';
import { MAKO_ADDRESS } from '../contract';
import { roundsAbi } from '../rounds-abi';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const NOW = 1_790_000_000n;
const START = ((NOW + 600n + 59n) / 60n) * 60n; // first boundary at least 10 minutes ahead

const enter = encodeFunctionData({ abi: roundsAbi, functionName: 'enter', args: [7n, 1, 100_000n] });
const schedule = encodeFunctionData({ abi: roundsAbi, functionName: 'schedule', args: [START] });
const claim = encodeFunctionData({ abi: roundsAbi, functionName: 'claim', args: [7n] });
const approve = encodeFunctionData({
  abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const,
  functionName: 'approve',
  args: [ROUNDS, 100_000n],
});
const one = (kind: string, to: Address, data: Hex) => ({ kind, chainId: 10143, call: { to, value: '0x0', data } });

function mkReq(body: unknown): Request {
  return new Request('http://localhost/api/aa/sponsor', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
}

function happy(): void {
  mocks.getUserSession.mockResolvedValue({ userId: 'user-1', email: 'a@b.com', magicEoa: MAGIC_EOA, sessionId: 's-1' });
  mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
  mocks.loadInFlightForSafe.mockResolvedValue(null);
  mocks.incrementOrReject.mockResolvedValue({ kind: 'within_cap', count: 1 });
  mocks.getBlock.mockResolvedValue({ timestamp: NOW });
  mocks.readContract.mockResolvedValue(true);
  mocks.buildSponsoredUserOp.mockResolvedValue({
    userOp: {
      sender: SAFE, nonce: '0x0', initCode: '0x', callData: '0xdeadbeef', callGasLimit: '0x1', verificationGasLimit: '0x1',
      preVerificationGas: '0x1', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', paymaster: '0x3333333333333333333333333333333333333333',
      paymasterVerificationGasLimit: '0x1', paymasterPostOpGasLimit: '0x1', paymasterData: '0x',
    },
    safeOpHash: ('0x' + 'aa'.repeat(32)) as Hex,
    userOpHash: ('0x' + 'bb'.repeat(32)) as Hex,
    validAfter: 0n,
    validUntil: 0xffffffffffffn,
  });
  mocks.insertPending.mockResolvedValue({ kind: 'inserted', id: '00000000-0000-0000-0000-000000000001', expiresAt: new Date(Date.now() + 300_000) });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/aa/sponsor — Rounds kinds (Rounds live)', () => {
  it('round_enter: builds one call to ROUNDS', async () => {
    happy();
    const res = await POST(mkReq(one('round_enter', ROUNDS, enter)));
    expect(res.status).toBe(200);
    const args = mocks.buildSponsoredUserOp.mock.calls[0][0] as { call: { to: Address; data: Hex } };
    expect(args.call.to).toBe(ROUNDS);
    expect(args.call.data).toBe(enter);
  });

  it('the chain no longer shows the reviewed Rounds code: 503 round_unavailable, nothing built or counted (Codex S2 r1)', async () => {
    happy();
    const { assertRoundsRelease } = await import('@/lib/rounds-release');
    const { NotAllowedError } = await import('@/lib/aa-call-allowlist');
    vi.mocked(assertRoundsRelease).mockRejectedValueOnce(new NotAllowedError('round_unavailable', 'code_hash'));
    const res = await POST(mkReq(one('round_enter', ROUNDS, enter)));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_unavailable' });
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
  });

  it('round_enter_batched: builds [approve, enter]', async () => {
    happy();
    const res = await POST(mkReq({ kind: 'round_enter_batched', chainId: 10143, calls: [{ to: USDC_ADDRESS, value: '0x0', data: approve }, { to: ROUNDS, value: '0x0', data: enter }] }));
    expect(res.status).toBe(200);
    const args = mocks.buildSponsoredUserOp.mock.calls[0][0] as { calls: { to: Address }[] };
    expect(args.calls.map((c) => c.to)).toEqual([USDC_ADDRESS, ROUNDS]);
  });

  it('round_schedule by a creator: reads isCreator on the pinned ROUNDS for this Safe, then builds', async () => {
    happy();
    const res = await POST(mkReq(one('round_schedule', ROUNDS, schedule)));
    expect(res.status).toBe(200);
    expect(mocks.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ROUNDS, functionName: 'isCreator', args: [SAFE] }));
  });

  it('round_schedule by a non-creator: 403 round_not_creator, nothing built, no sponsored op counted', async () => {
    happy();
    mocks.readContract.mockResolvedValue(false);
    const res = await POST(mkReq(one('round_schedule', ROUNDS, schedule)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_not_creator' });
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
  });

  it('round_schedule when the creator read fails: 502, nothing built', async () => {
    happy();
    mocks.readContract.mockRejectedValue(new Error('rpc down'));
    const res = await POST(mkReq(one('round_schedule', ROUNDS, schedule)));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_state_rpc_failure' });
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('a malformed schedule is refused before any chain read (403, no block or creator read)', async () => {
    happy();
    const offBoundary = encodeFunctionData({ abi: roundsAbi, functionName: 'schedule', args: [START + 1n] });
    const res = await POST(mkReq(one('round_schedule', ROUNDS, offBoundary)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_bad_schedule_args' });
    expect(mocks.getBlock).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });

  it('a claim sent to the Pools contract under round_claim is refused as Rounds (403)', async () => {
    happy();
    const res = await POST(mkReq(one('round_claim', MAKO_ADDRESS, claim)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'round_bad_target' });
  });

  it('the daily sponsored-op cap applies to Rounds (429)', async () => {
    happy();
    mocks.incrementOrReject.mockResolvedValue({ kind: 'cap_exceeded', count: 11 });
    const res = await POST(mkReq(one('round_enter', ROUNDS, enter)));
    expect(res.status).toBe(429);
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });
});
