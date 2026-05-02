// ----------------------------------------------------------------------------
// src/lib/__tests__/api-aa-send-route.test.ts
//
// Route-level wiring test for /api/aa/send. The full route happy-path /
// recovery-matrix coverage requires a live Postgres test DB and is
// deferred (see plan §"Route tests"). What this file locks in is the
// specific wiring sub-phase D round-1 added: `assertSponsoredCallData`
// is invoked with the row's persisted callData BEFORE `sendSignedUserOp`.
//
// Phase 1D Group 2 changed the reason code: the original strict op=0
// rule (any op=1 → `bad_operation`) was relaxed so op=1 is allowed when
// wrapper.to is the canonical MultiSendCallOnly. This test fixture's
// op=1 wrapper targets USDC (a non-MultiSendCallOnly address), which
// now rejects with the more specific `bad_multisend_target`. The
// security boundary is unchanged — the wrapper would still never have
// been sponsored — but the reason code is more informative.
//
// Modules mocked at the boundary so the route can run under vitest with
// no DB / no Magic / no Pimlico: csrf, user-session, aa-pending-user-ops
// DAO, user-op (lib).
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type Address, type Hex } from 'viem';

import { MAKO_ADDRESS } from '../contract';
import { buildBadOuterArgsWrapper } from './aa-test-helpers';

import { USDC_ADDRESS } from '../usdc';

// vi.mock factories are hoisted above all imports, so any state they
// reference must be created via vi.hoisted (which is also hoisted).
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

vi.mock('@/lib/user-op', async (importOriginal) => {
  // Mock only the orchestration entry points the route under test
  // calls. The pure helpers (encodeMultiSendBytes,
  // encodeBatchedExecuteUserOpCallData) need to remain real because
  // aa-test-helpers.ts pulls them in for fixture construction.
  const actual = await importOriginal<typeof import('../user-op')>();
  return {
    ...actual,
    sendSignedUserOp: (args: unknown) => mocks.sendSignedUserOp(args),
    resolveSubmittedOp: (args: unknown) => mocks.resolveSubmittedOp(args),
  };
});

// Import after vi.mock so the route picks up the mocked modules.
import { POST } from '../../app/api/aa/send/route';

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

const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

const SAFE: Address = '0x1111111111111111111111111111111111111111';

function encodeWrapperWithOperation(operation: 0 | 1): Hex {
  if (operation === 0) {
    // op=0 (CALL) — legitimate single-call wrapper test. Inner data
    // is a USDC.transfer to the Safe (smoke flow shape).
    return encodeFunctionData({
      abi: SAFE_WRAPPER_ABI,
      functionName: 'executeUserOp',
      args: [
        USDC_ADDRESS,
        0n,
        encodeFunctionData({
          abi: TRANSFER_ABI,
          functionName: 'transfer',
          args: [SAFE, 1n],
        }),
        operation,
      ],
    });
  }
  // op=1 (DELEGATECALL) — bad_multisend_target test: outer `to` is
  // USDC (not canonical MultiSendCallOnly). The validator rejects on
  // outer target before decoding inner data, so the inner content is
  // arbitrary; we use the production-shaped multiSend(bytes) wrap to
  // exercise the same wrapper shape buildSponsoredUserOp emits.
  const filler: Hex = '0x';
  return buildBadOuterArgsWrapper({
    to: USDC_ADDRESS, // non-canonical → bad_multisend_target
    value: 0n,
    calls: [
      { to: USDC_ADDRESS, value: 0n, data: filler },
      { to: MAKO_ADDRESS, value: 0n, data: filler },
    ],
  });
}

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

describe('/api/aa/send — assertSponsoredCallData wiring', () => {
  it('returns 403 NOT_ALLOWED bad_multisend_target when persisted callData has operation=1 + non-MultiSendCallOnly target, BEFORE sendSignedUserOp', async () => {
    // Sub-phase D's original test asserted op=1 → bad_operation (the
    // original strict rule was "operation must be 0"). Phase 1D Group 2
    // relaxed that: op=1 is now ALLOWED but only when wrapper.to is the
    // canonical MultiSendCallOnly. The fixture's wrapper targets USDC
    // (the smoke surface's transfer target), which is NOT
    // MultiSendCallOnly — so the validator now rejects with
    // `bad_multisend_target`. The semantics are equivalent (this exact
    // shape would never be sponsored), the reason code just got more
    // specific.
    mocks.getUserSession.mockResolvedValue({
      userId: 'user-1',
      email: 'a@b.com',
      magicEoa: '0x2222222222222222222222222222222222222222',
      sessionId: 'session-1',
    });
    mocks.loadById.mockResolvedValue(
      buildPendingRow({ callData: encodeWrapperWithOperation(1) }),
    );

    const res = await POST(mkReq(buildSendBody()));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('NOT_ALLOWED');
    expect(body.reason).toBe('bad_multisend_target');

    // Critical: sendSignedUserOp must NOT have been invoked. The whole
    // point of the round-1 wiring is to short-circuit before signing.
    expect(mocks.sendSignedUserOp).not.toHaveBeenCalled();
    // And the route must NOT have transitioned the row out of pending.
    expect(mocks.transitionToSending).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit on the allowlist when persisted callData has operation=0', async () => {
    mocks.getUserSession.mockResolvedValue({
      userId: 'user-1',
      email: 'a@b.com',
      magicEoa: '0x2222222222222222222222222222222222222222',
      sessionId: 'session-1',
    });
    mocks.loadById.mockResolvedValue(
      buildPendingRow({ callData: encodeWrapperWithOperation(0) }),
    );
    // Make the lib succeed so the test reaches sendSignedUserOp without
    // the route bailing on something unrelated.
    mocks.sendSignedUserOp.mockImplementation(async (args: { onUserOpHashComputed: (h: Hex) => Promise<void> }) => {
      await args.onUserOpHashComputed('0x' + 'cc'.repeat(32) as Hex);
      return {
        outcome: 'sent',
        userOpHash: ('0x' + 'cc'.repeat(32)) as Hex,
        txHash: ('0x' + 'dd'.repeat(32)) as Hex,
      };
    });
    mocks.transitionToSending.mockResolvedValue('transitioned');
    mocks.transitionToSent.mockResolvedValue(undefined);

    const res = await POST(mkReq(buildSendBody()));
    expect(res.status).toBe(200);

    // The allowlist did NOT reject; sendSignedUserOp WAS invoked once.
    expect(mocks.sendSignedUserOp).toHaveBeenCalledTimes(1);

    // The lib's onUserOpHashComputed callback fired transitionToSending
    // (gated on row id + sessionUserId + the locally-computed userOpHash).
    expect(mocks.transitionToSending).toHaveBeenCalledTimes(1);
    expect(mocks.transitionToSending).toHaveBeenCalledWith({
      rowId: '00000000-0000-0000-0000-000000000001',
      sessionUserId: 'user-1',
      userOpHash: ('0x' + 'cc'.repeat(32)) as Hex,
    });

    // SendOutcome 'sent' resolved through the route's switch into
    // transitionToSent with the bundled txHash. Argument check makes a
    // future regression (e.g., wiring the wrong field into the UPDATE)
    // surface here instead of at Stage 1.
    expect(mocks.transitionToSent).toHaveBeenCalledTimes(1);
    expect(mocks.transitionToSent).toHaveBeenCalledWith({
      rowId: '00000000-0000-0000-0000-000000000001',
      txHash: ('0x' + 'dd'.repeat(32)) as Hex,
    });

    // The 200 body must reflect the sent outcome's fields.
    const body = (await res.json()) as {
      status?: string;
      txHash?: string;
      userOpHash?: string;
    };
    expect(body.status).toBe('sent');
    expect(body.txHash).toBe('0x' + 'dd'.repeat(32));
    expect(body.userOpHash).toBe('0x' + 'cc'.repeat(32));
  });
});
