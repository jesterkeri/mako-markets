// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-sponsor-route-pm.test.ts
//
// Route-level wiring test for /api/aa/sponsor's Phase 2C-1 PM dispatch:
//
//   1. The new `case 'pm_create_market'` branch in the kind dispatch.
//   2. Stage-split RPC discipline:
//        a. Bad-shape body: Stage 1 fails BEFORE treasury/getBlock RPC
//           reads (RPC counts == 0 on reject).
//        b. Happy path: BOTH treasury + getBlock are awaited.
//   3. Draft-gate dispatch: helper-rejected reasons map 1:1 to
//      403 NOT_ALLOWED bodies (pm_draft_missing / pm_draft_wrong_creator
//      / pm_draft_shape_mismatch).
//   4. Builder arg shape — { call }, NOT { calls }.
//
// All DB-touching modules, the chain-RPC client, the treasury reader,
// and the draft-gate helper are mocked at the boundary so the test
// runs without Postgres / Pimlico / chain.
// ----------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

// #180 PM gate (sponsor route Step -1): the gate rejects pm_*
// kinds with 503 when NEXT_PUBLIC_PM_ENABLED is not "true". This
// file's tests exercise the POST-gate dispatch path, so set the
// flag to "true" before the route module imports, and restore
// the original value at file teardown so the flag doesn't leak
// into later test files in the same Vitest worker.
const PM_FLAG_KEY = 'NEXT_PUBLIC_PM_ENABLED';
const PM_FLAG_ORIGINAL = process.env[PM_FLAG_KEY];
beforeAll(() => {
  process.env[PM_FLAG_KEY] = 'true';
});
afterEach(() => {
  // Reset to "true" after each test in case any test toggles it.
  process.env[PM_FLAG_KEY] = 'true';
});
afterAll(() => {
  if (PM_FLAG_ORIGINAL === undefined) delete process.env[PM_FLAG_KEY];
  else process.env[PM_FLAG_KEY] = PM_FLAG_ORIGINAL;
});

import { PM_CONTRACT_ADDRESS } from '../contract';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';

const SAFE: Address = '0x000000000000000000000000000000000000beef';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const TREASURY: Address = '0x000000000000000000000000000000000000c0de';
const NOW_SEC = 1_800_000_000n;
const NONCE: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

function makeFriendly(
  overrides: Partial<PmCreateParamsTuple> = {},
): PmCreateParamsTuple {
  return {
    shape: 0,
    stakingOpensAt: NOW_SEC + 60n,
    closeAt: NOW_SEC + 3600n,
    title: '0x57696c6c20697420726169', // 'Will it rai'
    description: '0x',
    streamUrl: '0x',
    optionLabels: ['0x4e4f', '0x594553'], // 'NO', 'YES'
    participantWallets: [],
    allowlist: [],
    viewMode: 1,
    participationMode: 0,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    clientNonce: NONCE,
    ...overrides,
  };
}

function encode(params: PmCreateParamsTuple): Hex {
  return encodeFunctionData({
    abi: PM_CREATE_MARKET_ABI,
    functionName: 'createMarket',
    args: [params],
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
  getPmTreasuryAddress: vi.fn(),
  assertPmSponsorDraft: vi.fn(),
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
  }),
}));
vi.mock('@/lib/private-markets/treasury', () => ({
  getPmTreasuryAddress: () => mocks.getPmTreasuryAddress(),
}));
vi.mock('@/lib/private-markets/sponsor-gate', () => ({
  assertPmSponsorDraft: (args: unknown) => mocks.assertPmSponsorDraft(args),
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
  mocks.getPmTreasuryAddress.mockResolvedValue(TREASURY);
  mocks.assertPmSponsorDraft.mockResolvedValue({
    ok: true,
    pendingDbId: '00000000-0000-0000-0000-00000000aaaa',
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

describe('/api/aa/sponsor — pm_create_market dispatch (Phase 2C-1)', () => {
  it('happy path: 200 + buildSponsoredUserOp called with { call } shape (NOT { calls })', async () => {
    setupHappyPathMocks();

    const data = encode(makeFriendly());
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );
    expect(res.status).toBe(200);

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
    expect(buildArgs.call!.to.toLowerCase()).toBe(
      PM_CONTRACT_ADDRESS.toLowerCase(),
    );
    expect(buildArgs.call!.value).toBe(0n);
    expect(buildArgs.call!.data).toBe(data);
    expect(buildArgs.safeAddress).toBe(SAFE);
    expect(buildArgs.magicEoa).toBe(MAGIC_EOA);
  });

  it('Stage 1 rejection short-circuits BEFORE treasury/getBlock RPC reads', async () => {
    setupHappyPathMocks();

    // Immutable shape failure: closeAt === stakingOpensAt → Stage 1
    // rejects with pm_bad_create_timestamps before ANY RPC is issued.
    const data = encode(
      makeFriendly({
        stakingOpensAt: NOW_SEC + 100n,
        closeAt: NOW_SEC + 100n,
      }),
    );
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('pm_bad_create_timestamps');

    // Critical short-circuit: NO RPC reads happened, NO helper called,
    // NO rate-limit increment, NO Pimlico call.
    expect(mocks.getPmTreasuryAddress).not.toHaveBeenCalled();
    expect(mocks.getBlock).not.toHaveBeenCalled();
    expect(mocks.assertPmSponsorDraft).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('Stage 3 clock rejection happens AFTER RPC reads but BEFORE draft gate', async () => {
    setupHappyPathMocks();

    // stakingOpensAt < nowSec → Stage 3 rejects with
    // pm_bad_create_timestamps.
    const data = encode(
      makeFriendly({
        stakingOpensAt: NOW_SEC - 100n,
        closeAt: NOW_SEC + 3600n,
      }),
    );
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.reason).toBe('pm_bad_create_timestamps');

    // RPC reads DID happen (Stage 3 needs them).
    expect(mocks.getPmTreasuryAddress).toHaveBeenCalledTimes(1);
    expect(mocks.getBlock).toHaveBeenCalledTimes(1);
    // But draft gate + downstream did NOT.
    expect(mocks.assertPmSponsorDraft).not.toHaveBeenCalled();
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('pm_draft_missing: helper rejects → 403 with reason, builder not called', async () => {
    setupHappyPathMocks();
    mocks.assertPmSponsorDraft.mockResolvedValue({
      ok: false,
      reason: 'pm_draft_missing',
    });

    const data = encode(makeFriendly());
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('pm_draft_missing');

    expect(mocks.assertPmSponsorDraft).toHaveBeenCalledTimes(1);
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
  });

  it('pm_draft_wrong_creator: 403 surfaces helper reason', async () => {
    setupHappyPathMocks();
    mocks.assertPmSponsorDraft.mockResolvedValue({
      ok: false,
      reason: 'pm_draft_wrong_creator',
    });

    const data = encode(makeFriendly());
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('pm_draft_wrong_creator');
  });

  it('pm_draft_shape_mismatch: 403 surfaces helper reason', async () => {
    setupHappyPathMocks();
    mocks.assertPmSponsorDraft.mockResolvedValue({
      ok: false,
      reason: 'pm_draft_shape_mismatch',
    });

    const data = encode(makeFriendly());
    const res = await POST(
      mkReq({
        kind: 'pm_create_market',
        chainId: 10143,
        call: { to: PM_CONTRACT_ADDRESS, value: '0x0', data },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('pm_draft_shape_mismatch');
  });
});
