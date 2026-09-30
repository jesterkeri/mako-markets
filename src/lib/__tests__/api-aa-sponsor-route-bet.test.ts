// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-sponsor-route-bet.test.ts
//
// Route-level wiring test for /api/aa/sponsor's Phase 1D bet dispatch.
// Mirrors the vi.hoisted mocking pattern from api-aa-send-route-bet.test.ts
// to exercise the production changes Group 4 introduced:
//
//   1. parsed.data.kind switch dispatching to the right validator.
//   2. Hex-bigint value conversion via viem's hexToBigInt — the happy-
//      path assertions check `value === 0n` (a bigint), which only holds
//      if `'0x0'` was converted via hexToBigInt; a raw string would
//      compare unequal to `0n` and the validator would reject.
//   3. buildSponsoredUserOp arg shape — { call } for smoke/bet_single,
//      { calls } for bet_batched.
//
// Five tests cover bet_single happy + reject, bet_batched happy + reject,
// plus a `value: '0x1'` test that locks the route's `bad_value` response
// shape for nonzero hex values. (The conversion proof is in the happy
// paths, not in the nonzero test — see comment on the latter.)
//
// All DB-touching modules mocked at the boundary so the test runs without
// Postgres / Magic / Pimlico.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';

import { MAKO_ADDRESS } from '../contract';
import { USDC_ADDRESS } from '../usdc';

const MAX_UINT_256 = (1n << 256n) - 1n;
const SAFE: Address = '0x1111111111111111111111111111111111111111';
const MAGIC_EOA: Address = '0x2222222222222222222222222222222222222222';
const NON_MAKO: Address = '0x4444444444444444444444444444444444444444';

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

const PLACEBET_ABI = [
  {
    type: 'function',
    name: 'placeBet',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'isYes', type: 'bool' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
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

function encodePlaceBet(id: bigint, isYes: boolean, amount: bigint): Hex {
  return encodeFunctionData({
    abi: PLACEBET_ABI,
    functionName: 'placeBet',
    args: [id, isYes, amount],
  });
}

// ── vi.hoisted mock registry ────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getUserSession: vi.fn(),
  selectFromUserSafes: vi.fn(),
  loadInFlightForSafe: vi.fn(),
  insertPending: vi.fn(),
  incrementOrReject: vi.fn(),
  decrementForRefund: vi.fn(),
  buildSponsoredUserOp: vi.fn(),
}));

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: () => ({ ok: true }),
}));

vi.mock('@/lib/user-session', () => ({
  getUserSession: () => mocks.getUserSession(),
}));

// Mock the Drizzle chain shape the route uses for the user_safes lookup.
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
    validUntil: 0xFFFFFFFFFFFFn,
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

describe('/api/aa/sponsor — bet dispatch (Phase 1D Group 4)', () => {
  it('bet_single happy path: validator passes, buildSponsoredUserOp called with { call } shape', async () => {
    setupHappyPathMocks();

    const placeBetData = encodePlaceBet(42n, true, 100n);
    const res = await POST(
      mkReq({
        kind: 'bet_single',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x0', data: placeBetData },
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
    // Single-call shape — `call` defined, `calls` absent.
    expect(buildArgs.call).toBeDefined();
    expect(buildArgs.calls).toBeUndefined();
    expect(buildArgs.call!.to).toBe(MAKO_ADDRESS);
    expect(buildArgs.call!.value).toBe(0n); // hexToBigInt('0x0') === 0n
    expect(buildArgs.call!.data).toBe(placeBetData);
    expect(buildArgs.safeAddress).toBe(SAFE);
    expect(buildArgs.magicEoa).toBe(MAGIC_EOA);
  });

  it('bet_batched happy path: validator passes, buildSponsoredUserOp called with { calls } tuple', async () => {
    setupHappyPathMocks();

    const approveData = encodeApprove(MAKO_ADDRESS, MAX_UINT_256);
    const placeBetData = encodePlaceBet(7n, false, 50n);
    const res = await POST(
      mkReq({
        kind: 'bet_batched',
        chainId: 10143,
        calls: [
          { to: USDC_ADDRESS, value: '0x0', data: approveData },
          { to: MAKO_ADDRESS, value: '0x0', data: placeBetData },
        ],
      }),
    );
    expect(res.status).toBe(200);

    expect(mocks.buildSponsoredUserOp).toHaveBeenCalledTimes(1);
    const buildArgs = mocks.buildSponsoredUserOp.mock.calls[0][0] as {
      chainId: number;
      safeAddress: Address;
      magicEoa: Address;
      call?: unknown;
      calls?: readonly [
        { to: Address; value: bigint; data: Hex },
        { to: Address; value: bigint; data: Hex },
      ];
    };
    // Batched shape — `calls` tuple defined, `call` absent.
    expect(buildArgs.call).toBeUndefined();
    expect(buildArgs.calls).toBeDefined();
    expect(buildArgs.calls!.length).toBe(2);
    expect(buildArgs.calls![0].to).toBe(USDC_ADDRESS);
    expect(buildArgs.calls![0].data).toBe(approveData);
    expect(buildArgs.calls![1].to).toBe(MAKO_ADDRESS);
    expect(buildArgs.calls![1].data).toBe(placeBetData);
    // Hex value '0x0' converted to bigint 0n on both calls.
    expect(buildArgs.calls![0].value).toBe(0n);
    expect(buildArgs.calls![1].value).toBe(0n);
  });

  it('bet_single bad shape: validator throws → 403 NOT_ALLOWED bad_placebet_args BEFORE rate-limit + lib', async () => {
    setupHappyPathMocks();

    // placeBet target is NOT MAKO — assertBetSingleCall rejects with
    // bad_placebet_args.
    const placeBetData = encodePlaceBet(1n, true, 100n);
    const res = await POST(
      mkReq({
        kind: 'bet_single',
        chainId: 10143,
        call: { to: NON_MAKO, value: '0x0', data: placeBetData },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_placebet_args');

    // Critical short-circuit assertions: validator failure must NOT
    // touch the rate limit or the lib. The user pays no daily-cap cost
    // for sending a malformed body, and Pimlico is not contacted.
    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  it('bet_batched bad shape: validator throws → 403 with reason BEFORE lib', async () => {
    setupHappyPathMocks();

    // Approve amount ≠ MaxUint256 — assertBetBatchedCalls rejects with
    // bad_approval_amount.
    const badApprove = encodeApprove(MAKO_ADDRESS, 1n);
    const placeBet = encodePlaceBet(1n, true, 100n);
    const res = await POST(
      mkReq({
        kind: 'bet_batched',
        chainId: 10143,
        calls: [
          { to: USDC_ADDRESS, value: '0x0', data: badApprove },
          { to: MAKO_ADDRESS, value: '0x0', data: placeBet },
        ],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_approval_amount');

    expect(mocks.incrementOrReject).not.toHaveBeenCalled();
    expect(mocks.buildSponsoredUserOp).not.toHaveBeenCalled();
    expect(mocks.insertPending).not.toHaveBeenCalled();
  });

  it('locks the bad_value response for nonzero hex value', async () => {
    // Note: this test does NOT prove hex→bigint conversion on its own —
    // a raw string `'0x1'` would also compare unequal to `0n` and produce
    // bad_value. The conversion proof lives in the bet_single + bet_batched
    // happy-path tests above, which assert `value === 0n` (a bigint
    // strict-equality that only holds after the route runs hexToBigInt).
    // This test exists only to lock in the response shape on the rejected
    // nonzero path so a future change to the validator's reason mapping
    // surfaces here.
    setupHappyPathMocks();

    const placeBetData = encodePlaceBet(1n, true, 100n);
    const res = await POST(
      mkReq({
        kind: 'bet_single',
        chainId: 10143,
        call: { to: MAKO_ADDRESS, value: '0x1', data: placeBetData },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_value');
  });
});
