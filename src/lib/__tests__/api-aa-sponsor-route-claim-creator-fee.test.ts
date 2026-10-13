// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-sponsor-route-claim-creator-fee.test.ts
//
// Creator earnings through POST /api/aa/sponsor (kind='claim_creator_fee'), with the browser's own body builder
// (`buildClaimCreatorFeeBody`) as input, so the wire shape, the route schema, the allowlist and the route dispatch
// are tested together. A refusal must happen before the daily sponsored-op count or the user-op build.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { buildClaimCreatorFeeBody } from '../aa-client';
import { MONAD_TESTNET_ID } from '../chain';
import { MAKO_ADDRESS } from '../contract';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
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
  loadInFlightForSafe: (args: unknown) => mocks.loadInFlightForSafe(args),
  insertPending: (args: unknown) => mocks.insertPending(args),
}));
vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: (args: unknown) => mocks.incrementOrReject(args),
  decrementForRefund: (args: unknown) => mocks.decrementForRefund(args),
}));
vi.mock('@/lib/user-op', async (importActual) => ({
  ...(await importActual<typeof import('../user-op')>()),
  buildSponsoredUserOp: (args: unknown) => mocks.buildSponsoredUserOp(args),
}));
// The creator-fee path reads nothing from the chain; any read would be a regression.
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => {
    throw new Error('claim_creator_fee must not read the chain at sponsor time');
  },
}));

import { POST } from '../../app/api/aa/sponsor/route';

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
  mocks.buildSponsoredUserOp.mockResolvedValue({
    userOp: {
      sender: SAFE,
      nonce: '0x0',
      initCode: '0x',
      callData: '0xdeadbeef',
      callGasLimit: '0x186a0',
      verificationGasLimit: '0x186a0',
      preVerificationGas: '0x186a0',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
      paymaster: '0x3333333333333333333333333333333333333333',
      paymasterVerificationGasLimit: '0x186a0',
      paymasterPostOpGasLimit: '0x186a0',
      paymasterData: '0x',
    },
    safeOpHash: ('0x' + 'aa'.repeat(32)) as Hex,
    userOpHash: ('0x' + 'bb'.repeat(32)) as Hex,
    validAfter: 0n,
    validUntil: 0xffffffffffffn,
  });
  mocks.insertPending.mockResolvedValue({ kind: 'inserted', id: '00000000-0000-0000-0000-000000000001', expiresAt: new Date(Date.now() + 300_000) });
}

const body = (marketId: bigint) => buildClaimCreatorFeeBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId });

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/aa/sponsor, claim_creator_fee', () => {
  it("sponsors the browser builder's claimCreatorFee(id) as one call to the V4 Pools contract", async () => {
    happy();
    const b = body(41n);
    const res = await POST(mkReq(b));
    expect(res.status).toBe(200);
    expect(mocks.buildSponsoredUserOp).toHaveBeenCalledTimes(1);
    const args = mocks.buildSponsoredUserOp.mock.calls[0][0] as { call?: { to: string; value: bigint; data: Hex }; calls?: unknown };
    expect(args.calls).toBeUndefined();
    expect(args.call?.to.toLowerCase()).toBe(MAKO_ADDRESS.toLowerCase());
    expect(args.call?.value).toBe(0n);
    expect(args.call?.data).toBe(b.kind === 'claim_creator_fee' ? b.call.data : null);
    expect(args.call?.data.slice(0, 10)).toBe('0xb340da9c');
  });

  it('refuses the winnings claim under this kind (403), before the daily count or the build', async () => {
    happy();
    const claimData = encodeFunctionData({
      abi: [{ type: 'function', name: 'claim', inputs: [{ name: 'id', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const,
      functionName: 'claim',
      args: [41n],
    });
    const res = await POST(mkReq({ kind: 'claim_creator_fee', chainId: MONAD_TESTNET_ID, call: { to: MAKO_ADDRESS, value: '0x0', data: claimData } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'bad_claim_creator_fee_args' });
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('refuses claimCreatorFee aimed at USDC (403)', async () => {
    happy();
    const b = body(41n);
    if (b.kind !== 'claim_creator_fee') throw new Error('unexpected body');
    const res = await POST(mkReq({ ...b, call: { ...b.call, to: USDC_ADDRESS } }));
    expect(res.status).toBe(403);
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('refuses an extra `calls` key (400, strict schema)', async () => {
    happy();
    const b = body(41n);
    if (b.kind !== 'claim_creator_fee') throw new Error('unexpected body');
    const res = await POST(mkReq({ ...b, calls: [b.call, b.call] }));
    expect(res.status).toBe(400);
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('the creator-fee selector is still refused under kind=claim (403)', async () => {
    happy();
    const b = body(41n);
    if (b.kind !== 'claim_creator_fee') throw new Error('unexpected body');
    const res = await POST(mkReq({ kind: 'claim', chainId: MONAD_TESTNET_ID, call: b.call }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'bad_claim_args' });
  });
});
