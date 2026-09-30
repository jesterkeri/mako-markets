// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-sponsor-route-create-batched.test.ts
//
// Route-level coverage for /api/aa/sponsor's `kind: 'create_market_batched'`
// branch (codex r1 4e MAJOR 2). The single-call route test
// (api-aa-sponsor-route-create.test.ts) already pins the kind='create_market'
// path; this file pins:
//
//   1. Happy path: validators + buildSponsoredUserOp wired correctly, dispatch
//      lands on `{ calls }` shape (NOT `{ call }`) — a future implementer
//      accidentally routing batched through the single-call builder would
//      break this assertion.
//   2. Shape preflight rejection: a malformed approve sub-call short-circuits
//      BEFORE getBlock / incrementOrReject / buildSponsoredUserOp. No RPC,
//      no rate limit cost, no Pimlico call for a doomed body.
//   3. MAKO rejection: the new `bad_create_mako_in_batched_path` gate fires
//      at the route level, regardless of safeAddress.
//   4. Blocked-safe rejection: the chain-read blocklist gate surfaces as
//      `bad_create_blocked_wallet` for non-MAKO creates.
//
// All DB-touching modules and the chain-RPC client are mocked at the
// boundary so the test runs without Postgres / Pimlico / chain.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, maxUint256, type Address, type Hex } from 'viem';

import { MAKO_ADDRESS } from '../contract';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const NOW_SEC = 1_800_000_000n;

const ORACLE_REF: Hex =
  '0xab0000000000000000000000000000000000000000000000000000000000ffaa';

const APPROVE_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const CREATEMARKET_ABI = [
  {
    type: 'function',
    name: 'createMarket',
    inputs: [
      { name: 'mType', type: 'uint8' },
      { name: 'oracleRef', type: 'bytes32' },
      { name: 'bettingCloseTime', type: 'uint64' },
      { name: 'closeTime', type: 'uint64' },
      { name: 'question', type: 'string' },
      { name: 'creatorSeed', type: 'uint256' },
      { name: 'creatorYes', type: 'bool' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

function encodeApprove(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

function encodeCreateMarket(args: {
  mType: number;
  oracleRef?: Hex;
  bettingCloseTime?: bigint;
  closeTime?: bigint;
  question?: string;
  creatorSeed?: bigint;
  creatorYes?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: CREATEMARKET_ABI,
    functionName: 'createMarket',
    args: [
      args.mType,
      args.oracleRef ?? ORACLE_REF,
      args.bettingCloseTime ?? NOW_SEC + 1800n,
      args.closeTime ?? NOW_SEC + 3600n,
      args.question ?? 'BTC > 100k by close?',
      args.creatorSeed ?? 1_000_000n,
      args.creatorYes ?? true,
    ],
  });
}

/// Build a canonical 2-call route body. Each test overrides whichever
/// slot it's exercising.
function batchedBody(overrides?: {
  approveSpender?: Address;
  approveAmount?: bigint;
  createArgs?: Parameters<typeof encodeCreateMarket>[0];
}) {
  return {
    kind: 'create_market_batched' as const,
    chainId: 10143,
    calls: [
      {
        to: USDC_ADDRESS,
        value: '0x0',
        data: encodeApprove(
          overrides?.approveSpender ?? MAKO_ADDRESS,
          overrides?.approveAmount ?? maxUint256,
        ),
      },
      {
        to: MAKO_ADDRESS,
        value: '0x0',
        data: encodeCreateMarket(overrides?.createArgs ?? { mType: 1 }),
      },
    ],
  };
}

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

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: () => ({ ok: true }),
}));

vi.mock('@/lib/user-session', () => ({
  getUserSession: () => mocks.getUserSession(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => mocks.selectFromUserSafes(),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/aa-pending-user-ops', () => ({
  loadInFlightForSafe: (args: unknown) => mocks.loadInFlightForSafe(args),
  insertPending: (args: unknown) => mocks.insertPending(args),
}));

vi.mock('@/lib/aa-sponsor-limits', () => ({
  incrementOrReject: (args: unknown) => mocks.incrementOrReject(args),
  decrementForRefund: (args: unknown) => mocks.decrementForRefund(args),
}));

// The real wrapper encoder (the route compares pending ops with it); only the builder is mocked.
vi.mock('@/lib/user-op', async (importActual) => ({
  ...(await importActual<typeof import('../user-op')>()),
  buildSponsoredUserOp: (args: unknown) => mocks.buildSponsoredUserOp(args),
}));

vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    getBlock: () => mocks.getBlock(),
    readContract: (args: unknown) => mocks.readContract(args),
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

function setupHappyPathMocks(): void {
  mocks.getUserSession.mockResolvedValue({
    userId: 'user-1',
    email: 'a@b.com',
    magicEoa: MAGIC_EOA,
    sessionId: 'session-1',
  });
  mocks.selectFromUserSafes.mockResolvedValue([{ safeAddress: SAFE }]);
  mocks.loadInFlightForSafe.mockResolvedValue(null);
  mocks.incrementOrReject.mockResolvedValue({ kind: 'within_cap', count: 1 });
  mocks.getBlock.mockResolvedValue({ timestamp: NOW_SEC });
  // Default: non-blocked Safe + 0/10 daily creates. Slice 4f added the
  // second read; dispatch by functionName so both resolve.
  mocks.readContract.mockImplementation((args: unknown) => {
    const fn = (args as { functionName?: string }).functionName;
    if (fn === 'creatorCreatesToday') {
      return Promise.resolve([0n, 10n] as const);
    }
    return Promise.resolve(false); // blocked()
  });
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
  mocks.insertPending.mockResolvedValue({
    kind: 'inserted',
    id: '00000000-0000-0000-0000-000000000001',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/aa/sponsor — create_market_batched dispatch (codex r1 4e MAJOR 2)', () => {
  it('happy path: validators pass, buildSponsoredUserOp called with { calls } shape (NOT { call })', async () => {
    setupHappyPathMocks();

    const res = await POST(mkReq(batchedBody()));
    expect(res.status).toBe(200);

    // The dispatch invariant — batched routes through `{ calls }`. A
    // regression that re-pointed this branch at the single-call
    // builder would surface here.
    expect(mocks.buildSponsoredUserOp).toHaveBeenCalledTimes(1);
    // The route's buildSponsoredUserOp call passes EITHER `call` (single)
    // or `calls` (batched), not both — the function arg shape is a
    // discriminated union. Batched MUST land on the `calls` branch.
    const buildArgs = mocks.buildSponsoredUserOp.mock.calls[0][0] as {
      call?: unknown;
      calls?: ReadonlyArray<{ to: Address; value: bigint; data: Hex }>;
    };
    expect(buildArgs.calls).toBeDefined();
    expect(buildArgs.call).toBeUndefined();
    expect(buildArgs.calls).toHaveLength(2);
    expect(buildArgs.calls![0].to.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(buildArgs.calls![1].to.toLowerCase()).toBe(MAKO_ADDRESS.toLowerCase());

    // Chain-time read happened (sponsor validator pulls latest block).
    expect(mocks.getBlock).toHaveBeenCalledTimes(1);
    // Two chain-reads: blocked(safe) + creatorCreatesToday(safe).
    expect(mocks.readContract).toHaveBeenCalledTimes(2);
  });

  it('malformed preflight: shape validator throws → 403 BEFORE getBlock + cap + Pimlico', async () => {
    setupHappyPathMocks();

    // Approve amount != MaxUint256 → bad_approval_amount at the
    // pre-flight shape gate. Cheapest path: no chain reads, no rate
    // limit hit, no buildSponsoredUserOp call.
    const res = await POST(
      mkReq(
        batchedBody({
          approveAmount: 1_000_000n,
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_approval_amount');

    // The short-circuit invariant — getBlock + rate-limit + builder
    // are downstream of the shape check. None should fire.
    expect(mocks.getBlock).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  it('rejects MAKO in batched path with bad_create_mako_in_batched_path (codex r1 4e MAJOR 1)', async () => {
    setupHappyPathMocks();

    const res = await POST(
      mkReq(
        batchedBody({
          createArgs: { mType: 6, creatorSeed: 0n },
        }),
      ),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_mako_in_batched_path');

    // Critical: the MAKO gate fires at the pre-flight shape stage, so
    // no allowance request reaches Pimlico and no chain reads occur.
    expect(mocks.getBlock).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('rejects blocked safe with bad_create_blocked_wallet', async () => {
    setupHappyPathMocks();
    mocks.readContract.mockResolvedValueOnce(true); // chain says blocked

    const res = await POST(mkReq(batchedBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_blocked_wallet');

    // The blocklist check is a chain-read, so getBlock + readContract
    // BOTH fire (sponsor validator), but the builder does not.
    expect(mocks.getBlock).toHaveBeenCalled();
    expect(mocks.readContract).toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  // codex r1 4f-fe MINOR 2: cap-exceeded all the way through the route
  // for the batched path. Blocked → false, creatorCreatesToday →
  // [10n, 0n] → reason should surface unchanged from the recursive
  // single-call validator.
  it('daily cap exhausted: 403 NOT_ALLOWED + bad_create_daily_cap_exceeded', async () => {
    setupHappyPathMocks();
    mocks.readContract.mockImplementation((args: unknown) => {
      const fn = (args as { functionName?: string }).functionName;
      if (fn === 'creatorCreatesToday') {
        return Promise.resolve([10n, 0n] as const);
      }
      return Promise.resolve(false);
    });
    const res = await POST(mkReq(batchedBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_daily_cap_exceeded');
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  // codex r1 4f-fe MINOR 1: chain-read failure on batched path also
  // maps to 502 VALIDATE_FAILED (recursive single-call validator
  // bubbles the rejection, outer catch arm maps it).
  it('creatorCreatesToday read fails: 502 VALIDATE_FAILED', async () => {
    setupHappyPathMocks();
    mocks.readContract.mockImplementation((args: unknown) => {
      const fn = (args as { functionName?: string }).functionName;
      if (fn === 'creatorCreatesToday') {
        return Promise.reject(new Error('RPC timeout'));
      }
      return Promise.resolve(false);
    });
    const res = await POST(mkReq(batchedBody()));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('VALIDATE_FAILED');
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });
});
