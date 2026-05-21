// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-sponsor-route-create.test.ts
//
// Route-level wiring test for /api/aa/sponsor's Phase 1H create-market
// dispatch. Mirrors api-aa-sponsor-route-bet.test.ts to exercise:
//
//   1. The new `case 'create_market'` branch in the kind dispatch.
//   2. Chain-time read via getAaPublicClient — mocked to return a
//      fixed nowSec so the validator's clock-relative checks resolve
//      deterministically.
//   3. Builder arg shape — { call }, NOT { calls }. This is the
//      round-2 MAJOR 4 route-level pin: a future implementer must
//      not accidentally route create_market through the batched
//      path.
//   4. Validator short-circuit: bad timestamps reject with 403 BEFORE
//      the rate limit is touched and BEFORE buildSponsoredUserOp is
//      called.
//
// All DB-touching modules and the chain-RPC client are mocked at the
// boundary so the test runs without Postgres / Pimlico / chain.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { MAKO_ADDRESS } from '../contract';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const NOW_SEC = 1_800_000_000n;

const ORACLE_REF: Hex =
  '0xab0000000000000000000000000000000000000000000000000000000000ffaa';

// v4 redeploy: createMarket takes 7 args. The route-level test must
// encode against the deployed ABI; if this drifts back to 5 args the
// route returns bad_create_args (selector mismatch) before any
// validator-specific reason can be surfaced.
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

function encodeCreateMarket(args: {
  mType: number;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
  creatorSeed?: bigint;
  creatorYes?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: CREATEMARKET_ABI,
    functionName: 'createMarket',
    args: [
      args.mType,
      args.oracleRef,
      args.bettingCloseTime,
      args.closeTime,
      args.question,
      args.creatorSeed ?? 1_000_000n,
      args.creatorYes ?? true,
    ],
  });
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
  // v4 redeploy (slice 4a): non-MAKO createMarket validator now reads
  // MakoMarketsV4.blocked(safe) via aaClient.readContract. Mock it so
  // the route can resolve `readBlocked: false` and proceed.
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

vi.mock('@/lib/user-op', () => ({
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
  // Fixed chain-time the validator uses for clock-relative checks.
  mocks.getBlock.mockResolvedValue({ timestamp: NOW_SEC });
  // Default: the Safe is not blocked. The single-call validator reads
  // MakoMarketsV4.blocked(safe) for non-MAKO creates; this returns
  // false unless a specific test overrides it. Slice 4f added a second
  // read — creatorCreatesToday(safe) → (count, remaining). Dispatch by
  // functionName so both reads resolve correctly.
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

describe('/api/aa/sponsor — create_market dispatch (Phase 1H)', () => {
  it('happy path: validator passes, buildSponsoredUserOp called with { call } shape (NOT { calls })', async () => {
    setupHappyPathMocks();

    const data = encodeCreateMarket({
      mType: 0,
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'BTC > 100k by close?',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(200);

    // Round-2 MAJOR 4 pin: dispatch MUST land on the single-call
    // builder shape, not the batched shape. A future implementer
    // accidentally routing create_market through `{ calls }` would
    // break this assertion.
    expect(mocks.buildSponsoredUserOp).toHaveBeenCalledTimes(1);
    const buildArgs = mocks.buildSponsoredUserOp.mock.calls[0][0] as {
      chainId: number;
      safeAddress: Address;
      magicEoa: Address;
      call?: { to: Address; value: bigint; data: Hex };
      calls?: unknown;
    };
    expect(buildArgs.call).toBeDefined();
    expect(buildArgs.calls).toBeUndefined();
    expect(buildArgs.call!.to).toBe(MAKO_ADDRESS);
    expect(buildArgs.call!.value).toBe(0n);
    expect(buildArgs.call!.data).toBe(data);
    expect(buildArgs.safeAddress).toBe(SAFE);
    expect(buildArgs.magicEoa).toBe(MAGIC_EOA);
  });

  it('chain-time read happens for create_market (getBlock invoked)', async () => {
    setupHappyPathMocks();

    const data = encodeCreateMarket({
      mType: 1, // FOOTBALL
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'q',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(200);
    // The chain-time read is the new RPC dependency that exists ONLY
    // for create_market — pin its invocation here.
    expect(mocks.getBlock).toHaveBeenCalledTimes(1);
  });

  it('bad timestamps: validator throws → 403 BEFORE rate-limit + lib', async () => {
    setupHappyPathMocks();

    // Duration 1 hour past MAX_DURATION (7 days + 1 hour) → reject.
    const data = encodeCreateMarket({
      mType: 0,
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1000n,
      closeTime: NOW_SEC + 7n * 24n * 60n * 60n + 3600n,
      question: 'q',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_timestamps');

    // Critical short-circuit: validator failure MUST NOT touch the
    // rate limit or the lib. User pays no daily-cap cost for a
    // malformed body, and Pimlico is not contacted.
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  it('bad mType: validator throws → 403 bad_create_mtype_out_of_range', async () => {
    setupHappyPathMocks();

    // v4 redeploy enum widening: valid mTypes are {0..6} (FOOTBALL, CRYPTO,
    // BASKETBALL, FOREX, COMMODITIES, STOCKS, MAKO). 7 is out-of-range and
    // surfaces the dedicated reason added in slice 4c-1 (was the generic
    // bad_create_args under the old {0,1,2} regime).
    const data = encodeCreateMarket({
      mType: 7,
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'q',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_mtype_out_of_range');

    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  // codex r1 4f-fe MINOR 2: pin cap-exceeded all the way through the
  // route, not just the validator. The chain-read mock has to dispatch
  // by functionName so blocked() returns false but creatorCreatesToday
  // returns [10n, 0n] (remaining === 0n → bad_create_daily_cap_exceeded).
  it('daily cap exhausted: 403 NOT_ALLOWED + bad_create_daily_cap_exceeded BEFORE rate-limit + builder', async () => {
    setupHappyPathMocks();
    mocks.readContract.mockImplementation((args: unknown) => {
      const fn = (args as { functionName?: string }).functionName;
      if (fn === 'creatorCreatesToday') {
        return Promise.resolve([10n, 0n] as const);
      }
      return Promise.resolve(false);
    });
    const data = encodeCreateMarket({
      mType: 1, // CRYPTO (non-MAKO)
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'q',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_create_daily_cap_exceeded');
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  // codex r1 4f-fe MINOR 1: chain-read failure (RPC down, view reverts,
  // contract not yet redeployed) → mapped 502 VALIDATE_FAILED rather
  // than letting Next surface a generic 500 stack trace. Rate-limit +
  // builder must not have been called — no funds at risk.
  it('creatorCreatesToday read fails: 502 VALIDATE_FAILED, rate-limit + builder not touched', async () => {
    setupHappyPathMocks();
    mocks.readContract.mockImplementation((args: unknown) => {
      const fn = (args as { functionName?: string }).functionName;
      if (fn === 'creatorCreatesToday') {
        return Promise.reject(
          new Error('execution reverted: contract not deployed'),
        );
      }
      return Promise.resolve(false);
    });
    const data = encodeCreateMarket({
      mType: 1,
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'q',
    });
    const res = await POST(
      mkReq({
        kind: 'create_market',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('VALIDATE_FAILED');
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });
});
