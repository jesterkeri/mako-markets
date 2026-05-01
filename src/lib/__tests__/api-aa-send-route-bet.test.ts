// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-send-route-bet.test.ts
//
// Route-level wiring test for the Phase 1D bet-flow shape going through
// /api/aa/send. Mirrors the sub-phase D `api-aa-send-route.test.ts`
// vi.hoisted pattern (mocked DAO + session + lib) but exercises the
// batched MultiSend wrapper specifically.
//
// Plan v4 round-1 MINOR 4 + round-3 MINOR 2 lock-in: the send-side
// `assertSponsoredCallData` mirror MUST accept the same batched wrapper
// shape that `buildSponsoredUserOp({ calls })` produces. A wiring drift
// where the send route 403s every batched bet is exactly the kind of
// regression Group 4 needs to lock in at the route level (not just the
// helper level).
//
// Two assertions:
//   1. Accept path: a stored userOp.callData that wraps a valid
//      [approve(MAKO, MaxUint256), placeBet(...)] tuple via canonical
//      MultiSendCallOnly + op=1 → route does NOT 403; sendSignedUserOp
//      mock IS invoked with the row's callData intact.
//   2. Reject path: a stored userOp.callData with an invalid inner sub-
//      call (e.g., approve amount ≠ MaxUint256) → route returns 403
//      NOT_ALLOWED with the appropriate reason BEFORE sendSignedUserOp
//      is called.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';

import { encodeMultiSendBytes } from '../user-op';
import { MAKO_ADDRESS } from '../contract';
import { SAFE_CONFIG } from '../safe-config';
import { USDC_ADDRESS } from '../usdc';

const MAX_UINT_256 = (1n << 256n) - 1n;
const SAFE: Address = '0x1111111111111111111111111111111111111111';
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

const SAFE_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'executeUserOp',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
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

/// Build a batched-shape outer wrapper exactly the way
/// `buildSponsoredUserOp({ calls })` does: MultiSend bytes →
/// Safe.executeUserOp(MultiSendCallOnly, 0, bytes, 1).
function buildBatchedWrapperCallData(args: {
  approveCalldata: Hex;
  placeBetCalldata: Hex;
}): Hex {
  const multiSendBytes = encodeMultiSendBytes([
    { to: USDC_ADDRESS, value: 0n, data: args.approveCalldata },
    { to: MAKO_ADDRESS, value: 0n, data: args.placeBetCalldata },
  ]);
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [SAFE_CONFIG.multiSendCallOnly, 0n, multiSendBytes, 1],
  });
}

// ── vi.hoisted mock registry (same pattern as api-aa-send-route.test.ts) ────

const mocks = vi.hoisted(() => {
  class MockAlreadyClaimedError extends Error {
    constructor(public readonly rowId: string) {
      super(`mock already-claimed ${rowId}`);
      this.name = 'AlreadyClaimedError';
    }
  }
  return {
    getUserSession: vi.fn(),
    loadById: vi.fn(),
    transitionPendingToExpired: vi.fn(),
    transitionToSending: vi.fn(),
    transitionToSent: vi.fn(),
    transitionToReverted: vi.fn(),
    transitionToFailedPreSubmit: vi.fn(),
    transitionToSubmitted: vi.fn(),
    transitionFromSubmitted: vi.fn(),
    transitionFromSendingViaResolver: vi.fn(),
    sendSignedUserOp: vi.fn(),
    resolveSubmittedOp: vi.fn(),
    AlreadyClaimedError: MockAlreadyClaimedError,
  };
});

vi.mock('@/lib/csrf', () => ({
  checkSameOrigin: () => ({ ok: true }),
}));

vi.mock('@/lib/user-session', () => ({
  getUserSession: () => mocks.getUserSession(),
}));

vi.mock('@/lib/aa-pending-user-ops', () => ({
  AlreadyClaimedError: mocks.AlreadyClaimedError,
  loadById: (args: unknown) => mocks.loadById(args),
  transitionPendingToExpired: (args: unknown) =>
    mocks.transitionPendingToExpired(args),
  transitionToSending: (args: unknown) => mocks.transitionToSending(args),
  transitionToSent: (args: unknown) => mocks.transitionToSent(args),
  transitionToReverted: (args: unknown) => mocks.transitionToReverted(args),
  transitionToFailedPreSubmit: (args: unknown) =>
    mocks.transitionToFailedPreSubmit(args),
  transitionToSubmitted: (args: unknown) => mocks.transitionToSubmitted(args),
  transitionFromSubmitted: (args: unknown) =>
    mocks.transitionFromSubmitted(args),
  transitionFromSendingViaResolver: (args: unknown) =>
    mocks.transitionFromSendingViaResolver(args),
}));

vi.mock('@/lib/user-op', async () => {
  // Pull in the real module so the test still exports
  // `encodeMultiSendBytes` for our batched-wrapper builder.
  const actual = (await vi.importActual<
    typeof import('../user-op')
  >('../user-op')) as typeof import('../user-op');
  return {
    ...actual,
    sendSignedUserOp: (args: unknown) => mocks.sendSignedUserOp(args),
    resolveSubmittedOp: (args: unknown) => mocks.resolveSubmittedOp(args),
  };
});

import { POST } from '../../app/api/aa/send/route';

function buildPendingRow(args: { callData: Hex }) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    userId: 'user-1',
    chainId: 10143,
    safeAddress: SAFE,
    magicEoa: '0x2222222222222222222222222222222222222222',
    userOp: {
      sender: SAFE,
      nonce: '0x0',
      initCode: '0x',
      callData: args.callData,
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
    nonceHex: '0x0',
    safeOpHash: '0x' + 'aa'.repeat(32),
    status: 'pending' as const,
    userOpHash: null,
    txHash: null,
    failureReason: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    sendingStartedAt: null,
    statusUpdatedAt: new Date(),
  };
}

function buildSendBody() {
  return {
    pendingUserOpId: '00000000-0000-0000-0000-000000000001',
    signature: '0x' + 'ab'.repeat(77),
  };
}

function mkReq(body: unknown): Request {
  return new Request('http://localhost/api/aa/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('/api/aa/send — batched MultiSend wrapper (Phase 1D Group 4)', () => {
  it('accepts a valid batched [approve, placeBet] wrapper — sendSignedUserOp IS invoked', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: 'user-1',
      email: 'a@b.com',
      magicEoa: '0x2222222222222222222222222222222222222222',
      sessionId: 'session-1',
    });
    const callData = buildBatchedWrapperCallData({
      approveCalldata: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      placeBetCalldata: encodePlaceBet(1n, true, 100n),
    });
    mocks.loadById.mockResolvedValue(buildPendingRow({ callData }));

    // Make the lib succeed so the test can assert the route reached the
    // bundler call without hitting the assertSponsoredCallData mirror's
    // 403 path.
    mocks.sendSignedUserOp.mockImplementation(
      async (args: { onUserOpHashComputed: (h: Hex) => Promise<void> }) => {
        await args.onUserOpHashComputed(('0x' + 'cc'.repeat(32)) as Hex);
        return {
          outcome: 'sent',
          userOpHash: ('0x' + 'cc'.repeat(32)) as Hex,
          txHash: ('0x' + 'dd'.repeat(32)) as Hex,
        };
      },
    );
    mocks.transitionToSending.mockResolvedValue('transitioned');
    mocks.transitionToSent.mockResolvedValue(undefined);

    const res = await POST(mkReq(buildSendBody()));
    expect(res.status).toBe(200);

    // Critical: the route did NOT 403 on the wrapper. The mirror
    // accepted op=1 + canonical MultiSendCallOnly + valid sub-calls.
    expect(mocks.sendSignedUserOp).toHaveBeenCalledTimes(1);

    // The full row.userOp.callData (batched wrapper) flowed through to
    // the lib. If a future refactor accidentally rebuilds callData on
    // the route side, this assertion fires.
    const sendArgs = mocks.sendSignedUserOp.mock.calls[0][0] as {
      userOp: { callData: Hex };
    };
    expect(sendArgs.userOp.callData).toBe(callData);
  });

  it('rejects a batched wrapper with bad inner approve amount BEFORE sendSignedUserOp', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: 'user-1',
      email: 'a@b.com',
      magicEoa: '0x2222222222222222222222222222222222222222',
      sessionId: 'session-1',
    });
    const callData = buildBatchedWrapperCallData({
      // Approve amount ≠ MaxUint256 → mirror rejects with bad_approval_amount.
      approveCalldata: encodeApprove(MAKO_ADDRESS, 100n),
      placeBetCalldata: encodePlaceBet(1n, true, 100n),
    });
    mocks.loadById.mockResolvedValue(buildPendingRow({ callData }));

    const res = await POST(mkReq(buildSendBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_approval_amount');

    // Critical: the route short-circuited at the mirror BEFORE calling
    // the lib. If a future refactor moves the mirror after
    // sendSignedUserOp, this assertion fires.
    expect(mocks.sendSignedUserOp).not.toHaveBeenCalled();
    expect(mocks.transitionToSending).not.toHaveBeenCalled();
  });

  it('rejects a batched wrapper with bad inner placeBet target BEFORE sendSignedUserOp', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: 'user-1',
      email: 'a@b.com',
      magicEoa: '0x2222222222222222222222222222222222222222',
      sessionId: 'session-1',
    });
    // Inner placeBet target is NOT MAKO — mirror rejects with bad_placebet_args.
    const multiSendBytes = encodeMultiSendBytes([
      {
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeApprove(MAKO_ADDRESS, MAX_UINT_256),
      },
      { to: NON_MAKO, value: 0n, data: encodePlaceBet(1n, true, 100n) },
    ]);
    const callData = encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [SAFE_CONFIG.multiSendCallOnly, 0n, multiSendBytes, 1],
    });
    mocks.loadById.mockResolvedValue(buildPendingRow({ callData }));

    const res = await POST(mkReq(buildSendBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_placebet_args');
    expect(mocks.sendSignedUserOp).not.toHaveBeenCalled();
  });
});
