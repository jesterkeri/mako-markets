// /api/aa/sponsor step 6: the caller's own unsigned pending op is handed back only for the same request. A
// different request retires it and gets a new op, so a cancelled signature can never land an action other than the
// one on screen (adversary pass on the pool page, 2026-09-30).

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
// The real wrapper encoder: the comparison must use exactly what the builder would produce.
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

describe('/api/aa/sponsor step 6: a pending op is returned only for the same request', () => {
  const fifty = wrapperCallDataFor({ call: { to: MAKO_ADDRESS, value: 0n, data: placeBet(90n, true, 50_000_000n) } });

  it('hands back the pending op for an identical retry, and builds nothing', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty));
    const res = await POST(req(betBody(true, 50_000_000n)));
    expect(res.status).toBe(200);
    expect((await res.json()).recovered).toBe(true);
    expect(mocks.transitionPendingToExpired).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('retires the pending op and builds a new one for a different request', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty));
    mocks.transitionPendingToExpired.mockResolvedValue('transitioned');
    const res = await POST(req(betBody(false, 1_000_000n)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recovered).toBeUndefined();
    expect(mocks.transitionPendingToExpired).toHaveBeenCalledWith({ rowId: '00000000-0000-0000-0000-0000000000aa', sessionUserId: 'user-1' });
    expect(mocks.buildSponsoredUserOp).toHaveBeenCalledTimes(1);
  });

  it('answers in flight when another request started sending the old op first', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValueOnce(pendingRow(fifty)).mockResolvedValueOnce(pendingRow(fifty, { status: 'sending' }));
    mocks.transitionPendingToExpired.mockResolvedValue('already_claimed');
    const res = await POST(req(betBody(false, 1_000_000n)));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('IN_FLIGHT');
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('never retires an op that is already sending or belongs to someone else', async () => {
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty, { status: 'sending' }));
    expect((await POST(req(betBody(false, 1_000_000n)))).status).toBe(409);
    mocks.loadInFlightForSafe.mockResolvedValue(pendingRow(fifty, { userId: 'user-2' }));
    expect((await POST(req(betBody(false, 1_000_000n)))).status).toBe(409);
    expect(mocks.transitionPendingToExpired).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });
});
