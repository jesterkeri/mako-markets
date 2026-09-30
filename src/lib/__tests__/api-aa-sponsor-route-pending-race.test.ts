// /api/aa/sponsor: the caller's own pending op may be handed back (`recovered: true`) only for the same request, i.e.
// an identical Safe wrapper callData. Step 6 compares before handing back, but the two other paths that reach
// serializeExistingInFlight (the reload after a missed retire at step 6, and the race-loss reload at step 9) do not.
// Two different requests from one user at once (two tabs, a bet then a claim) reach them.

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

describe('/api/aa/sponsor: a different concurrent request is never answered with the other op', () => {
  const fifty = wrapperCallDataFor({ call: { to: MAKO_ADDRESS, value: 0n, data: placeBet(90n, true, 50_000_000n) } });

  it('step 9 race loss: a concurrent different request of the same user is not handed back as recovered', async () => {
    // Request A (YES 50) and request B (NO 1) race. Both see no in-flight row and both build; A inserts first, so B
    // conflicts and reloads A's pending row.
    happyPath();
    mocks.loadInFlightForSafe.mockResolvedValueOnce(null).mockResolvedValueOnce(pendingRow(fifty));
    mocks.insertPending.mockResolvedValue({ kind: 'conflict' });
    const res = await POST(req(betBody(false, 1_000_000n)));
    const body = await res.json();
    expect(body.recovered).not.toBe(true);
    expect(body.userOp?.callData).not.toBe(fifty);
  });

  it('step 6 missed retire: a different pending op written by another request meanwhile is not handed back', async () => {
    // This request (NO 1) sees P1 (YES 50). A third request retired P1 and inserted P2 (YES 7) before this request's
    // retire ran, so the retire misses and the reload returns P2, which is not this request.
    happyPath();
    const seven = wrapperCallDataFor({ call: { to: MAKO_ADDRESS, value: 0n, data: placeBet(90n, true, 7_000_000n) } });
    mocks.loadInFlightForSafe
      .mockResolvedValueOnce(pendingRow(fifty))
      .mockResolvedValueOnce(pendingRow(seven, { id: '00000000-0000-0000-0000-0000000000bb' }));
    mocks.transitionPendingToExpired.mockResolvedValue('already_claimed');
    const res = await POST(req(betBody(false, 1_000_000n)));
    const body = await res.json();
    expect(body.recovered).not.toBe(true);
    expect(body.userOp?.callData).not.toBe(seven);
  });
});
