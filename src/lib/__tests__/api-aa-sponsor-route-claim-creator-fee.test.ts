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

const CHAIN_NOW = 1_800_000_000n;
const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
  creatorFeeOpMayHaveLanded: vi.fn(),
  readContract: vi.fn(),
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
  CREATOR_FEE_OP_TTL_S: 300,
  CREATOR_FEE_MIN_SIGNING_S: 60,
  SUBMITTED_SETTLE_S: 600,
  loadInFlightForSafe: (args: unknown) => mocks.loadInFlightForSafe(args),
  creatorFeeOpMayHaveLanded: (args: unknown) => mocks.creatorFeeOpMayHaveLanded(args),
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
// The creator-fee path reads exactly one thing from the chain at sponsor time: getMarket(id).creatorFeeClaimed.
vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    readContract: (a: { functionName: string; args: unknown[] }) => mocks.readContract(a),
    getBlock: async () => ({ timestamp: CHAIN_NOW }),
  }),
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
  mocks.creatorFeeOpMayHaveLanded.mockResolvedValue(false);
  mocks.readContract.mockImplementation(async (a: { functionName: string }) => {
    if (a.functionName !== 'getMarket') throw new Error(`unexpected chain read ${a.functionName}`);
    return { creatorFeeClaimed: false };
  });
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

describe('/api/aa/sponsor, claim_creator_fee: one landed claim per pool (Codex CREATOR_EARNINGS R2)', () => {
  it('a creator-fee claim that already landed from this Safe is refused (403 creator_fee_already_sent), before the daily count or the build', async () => {
    happy();
    mocks.creatorFeeOpMayHaveLanded.mockResolvedValue(true);
    const res = await POST(mkReq(body(41n)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'creator_fee_already_sent' });
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    // Asked about exactly this Safe and this claim's Safe-wrapper callData.
    const asked = mocks.creatorFeeOpMayHaveLanded.mock.calls[0][0] as { chainId: number; safeAddress: string; callData: Hex };
    expect(asked.chainId).toBe(MONAD_TESTNET_ID);
    expect(asked.safeAddress.toLowerCase()).toBe(SAFE.toLowerCase());
    const { decodeFunctionData } = await import('viem');
    const outer = decodeFunctionData({
      abi: [{ type: 'function', name: 'executeUserOp', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }], outputs: [], stateMutability: 'nonpayable' }] as const,
      data: asked.callData,
    });
    const b = body(41n);
    expect(outer.args[2]).toBe(b.kind === 'claim_creator_fee' ? b.call.data : null);
  });

  it('another pool, or none landed: sponsored as usual', async () => {
    happy();
    const res = await POST(mkReq(body(42n)));
    expect(res.status).toBe(200);
    expect(mocks.creatorFeeOpMayHaveLanded).toHaveBeenCalledTimes(1);
  });

  it('the chain already shows the fee claimed (a wallet, another device, or an op the server lost track of): 403, nothing built', async () => {
    happy();
    mocks.readContract.mockResolvedValue({ creatorFeeClaimed: true });
    const res = await POST(mkReq(body(41n)));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED', reason: 'creator_fee_already_sent' });
    expect(mocks.readContract.mock.calls[0][0]).toMatchObject({ functionName: 'getMarket', args: [41n] });
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('the chain read fails: 502, refused (fail closed), nothing built', async () => {
    happy();
    mocks.readContract.mockRejectedValue(new Error('rpc down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(mkReq(body(41n)));
    expect(res.status).toBe(502);
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('the op it builds expires on chain 5 minutes after the chain time read, well inside the 10-minute repeat window (Codex R3)', async () => {
    happy();
    const { CREATOR_FEE_OP_TTL_S, SUBMITTED_SETTLE_S } = await vi.importActual<typeof import('../aa-pending-user-ops')>('../aa-pending-user-ops');
    const res = await POST(mkReq(body(41n)));
    expect(res.status).toBe(200);
    const args = mocks.buildSponsoredUserOp.mock.calls[0][0] as { validUntil?: bigint };
    expect(args.validUntil).toBe(CHAIN_NOW + BigInt(CREATOR_FEE_OP_TTL_S));
    // The old op is dead on chain at least SUBMITTED_SETTLE_S - CREATOR_FEE_OP_TTL_S before the window reopens.
    expect(SUBMITTED_SETTLE_S - CREATOR_FEE_OP_TTL_S).toBeGreaterThanOrEqual(300);
  });

  it("Codex R3's replay cannot happen: when the record releases a retry (>= 600 s on), the first op is already dead on chain, so it cannot land between the chain read and the nonce read", async () => {
    happy();
    const { CREATOR_FEE_OP_TTL_S, SUBMITTED_SETTLE_S } = await vi.importActual<typeof import('../aa-pending-user-ops')>('../aa-pending-user-ops');
    await POST(mkReq(body(41n)));
    const a = mocks.buildSponsoredUserOp.mock.calls[0][0] as { validUntil: bigint };
    // EntryPoint v0.7 rejects a UserOp whose validUntil is before the block timestamp (AA22 expired or not due).
    const canLandAt = (chainTime: bigint) => chainTime <= a.validUntil;
    // The record releases at the earliest SUBMITTED_SETTLE_S after A's row last changed, and that change is after A was
    // built; allow up to 4 minutes of chain/database clock skew in A's favour.
    const earliestRelease = CHAIN_NOW + BigInt(SUBMITTED_SETTLE_S) - 240n;
    expect(canLandAt(earliestRelease)).toBe(false);
    expect(canLandAt(CHAIN_NOW + BigInt(CREATOR_FEE_OP_TTL_S))).toBe(true); // and it is executable while it is meant to be
  });

  it('other kinds keep their default validity (only the creator-fee claim is time-bounded)', async () => {
    happy();
    const { buildClaimBody } = await import('../aa-client');
    await POST(mkReq(buildClaimBody({ chainId: MONAD_TESTNET_ID, makoAddress: MAKO_ADDRESS, marketId: 41n })));
    const args = mocks.buildSponsoredUserOp.mock.calls.at(-1)?.[0] as { validUntil?: bigint } | undefined;
    expect(args?.validUntil).toBeUndefined();
  });

  it('the shown words for that refusal say it was already claimed, nothing moved', async () => {
    const { phaseFromOutcome } = await import('../confirm-outcome');
    const p = phaseFromOutcome({ kind: 'sponsor_failed', status: 403, error: 'NOT_ALLOWED', reason: 'creator_fee_already_sent' }, { noun: 'claim', failTitle: "Claim didn't go through" });
    expect(p).toMatchObject({ step: 'failed', title: 'Already claimed', nothingMoved: true });
  });
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
