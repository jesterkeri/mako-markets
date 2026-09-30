// /api/aa/sponsor step 6 retires the caller's own pending op BEFORE the rate-limit increment (step 7) and the build
// (step 8). A different request that then fails at step 7 or 8 has destroyed the caller's live op and handed back
// neither a fresh op nor IN_FLIGHT, so the Safe is left with nothing to sign and, at the daily cap, no way to rebuild
// the op that already consumed a cap slot. Adversary pass, 2026-09-30.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { MAKO_ADDRESS } from '../contract';

const SAFE: Address = '0x1111111111111111111111111111111111111111';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const PLACEBET_ABI = [
  { type: 'function', name: 'placeBet', inputs: [{ name: 'id', type: 'uint256' }, { name: 'isYes', type: 'bool' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;
const placeBet = (id: bigint, isYes: boolean, amount: bigint): Hex => encodeFunctionData({ abi: PLACEBET_ABI, functionName: 'placeBet', args: [id, isYes, amount] });

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
  transitionPendingToExpired: vi.fn(),
  insertPending: vi.fn(),
  incrementOrReject: vi.fn(),
  decrementForRefund: vi.fn(),
  buildSponsoredUserOp: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({ checkSameOrigin: () => ({ ok: true }) }));
vi.mock('@/lib/user-session', () => ({ getUserSession: () => mocks.getUserSession() }));
vi.mock('@/db/client', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.selectFromUserSafes() }) }) }) },
}));
vi.mock('@/lib/aa-pending-user-ops', () => ({
  loadInFlightForSafe: (a: unknown) => mocks.loadInFlightForSafe(a),
  transitionPendingToExpired: (a: unknown) => mocks.transitionPendingToExpired(a),
  insertPending: (a: unknown) => mocks.insertPending(a),
}));
vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: (a: unknown) => mocks.incrementOrReject(a),
  decrementForRefund: (a: unknown) => mocks.decrementForRefund(a),
}));
// The real wrapper encoder, as in the step 6 test.
vi.mock('@/lib/user-op', async (importActual) => ({
  ...(await importActual<typeof import('../user-op')>()),
  buildSponsoredUserOp: (a: unknown) => mocks.buildSponsoredUserOp(a),
}));

import { POST } from '../../app/api/aa/sponsor/route';
import { wrapperCallDataFor } from '../user-op';

const req = (body: unknown) =>
  new Request('http://localhost/api/aa/sponsor', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) });
const betBody = (isYes: boolean, amount: bigint) => ({ kind: 'bet_single', chainId: 10143, call: { to: MAKO_ADDRESS, value: '0x0', data: placeBet(90n, isYes, amount) } });

function storedOp(callData: Hex) {
  return {
    sender: SAFE,
    nonce: '0x0',
    initCode: '0x',
    callData,
    callGasLimit: '0x1',
    verificationGasLimit: '0x1',
    preVerificationGas: '0x1',
    maxFeePerGas: '0x1',
    maxPriorityFeePerGas: '0x1',
    paymaster: '0x3333333333333333333333333333333333333333',
    paymasterVerificationGasLimit: '0x1',
    paymasterPostOpGasLimit: '0x1',
    paymasterData: '0x',
  };
}
const pendingRow = (callData: Hex, over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-0000000000aa',
  userId: 'user-1',
  status: 'pending',
  userOp: storedOp(callData),
  safeOpHash: ('0x' + 'cc'.repeat(32)) as Hex,
  expiresAt: new Date(Date.now() + 60_000),
  statusUpdatedAt: new Date(),
  ...over,
});

function happyPath() {
  mocks.getUserSession.mockResolvedValue({ userId: 'user-1', email: 'a@b.com', magicEoa: MAGIC_EOA, sessionId: 's-1' });
  mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
  mocks.incrementOrReject.mockResolvedValue({ kind: 'within_cap', count: 1 });
  mocks.buildSponsoredUserOp.mockResolvedValue({
    userOp: storedOp('0xdeadbeef'),
    safeOpHash: ('0x' + 'aa'.repeat(32)) as Hex,
    userOpHash: ('0x' + 'bb'.repeat(32)) as Hex,
    validAfter: 0n,
    validUntil: 0xffffffffffffn,
  });
  mocks.insertPending.mockResolvedValue({ kind: 'inserted', id: '00000000-0000-0000-0000-000000000001', expiresAt: new Date(Date.now() + 300_000) });
}

afterEach(() => vi.clearAllMocks());

describe('/api/aa/sponsor step 6: a request that builds nothing leaves the pending op alone and is always answered', () => {
  const fifty = wrapperCallDataFor({ call: { to: MAKO_ADDRESS, value: 0n, data: placeBet(90n, true, 50_000_000n) } });

  it('at the daily cap: a different request gets 429 and must leave the pending op alone', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty));
    mocks.transitionPendingToExpired.mockResolvedValue('transitioned');
    mocks.incrementOrReject.mockResolvedValue({ kind: 'cap_exceeded', count: 11 });
    const res = await POST(req(betBody(false, 1_000_000n)));
    expect(res.status).toBe(429);
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.transitionPendingToExpired).not.toHaveBeenCalled();
  });

  it('bundler rejects the build: a different request gets 503 and must leave the pending op alone', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty));
    mocks.transitionPendingToExpired.mockResolvedValue('transitioned');
    const { JsonRpcRejectError } = await import('../aa-rpc');
    mocks.buildSponsoredUserOp.mockRejectedValue(new JsonRpcRejectError({ method: 'pm_sponsorUserOperation', code: -32500, message: 'sponsor refused' }));
    const res = await POST(req(betBody(false, 1_000_000n)));
    expect([502, 503]).toContain(res.status);
    expect(mocks.insertPending).not.toHaveBeenCalled();
    expect(mocks.transitionPendingToExpired).not.toHaveBeenCalled();
  });

  it('a non-checksummed target that the allowlist accepts is answered, not thrown, at step 6', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty));
    const upper = ('0x' + MAKO_ADDRESS.slice(2).toUpperCase()) as Address;
    const body = { kind: 'bet_single', chainId: 10143, call: { to: upper, value: '0x0', data: placeBet(90n, false, 1_000_000n) } };
    const res = await POST(req(body)).catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Response);
  });
});
