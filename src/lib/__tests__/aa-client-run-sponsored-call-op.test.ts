// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-run-sponsored-call-op.test.ts
//
// Codex r1 MIN-1: branch coverage for the shared `runSponsoredCallOp`
// helper that backs every PM action orchestrator (and which previous
// PM tests only exercised on the sponsor-400 short-circuit path).
//
// Tests use `runPmClaim` as the entry point because it's the simplest
// PM orchestrator (no allowance branching, no extra args). The helper's
// behaviour is identical for every other orchestrator, so coverage on
// one variant covers all ten.
//
// Branches exercised:
//   1. sponsor 200 happy → sign → send 200 'sent' → RunOutcome 'sent'
//   2. sponsor 200 missing fields → 'sponsor_failed' with
//      'sponsor_bad_response'
//   3. sponsor 200 non-object body → 'sponsor_failed' with
//      'sponsor_bad_response'
//   4. sponsor 500 (server error) → 'sponsor_failed'
//   5. sponsor transport reject → 'sponsor_failed' with
//      'sponsor_transport_failed'
//   6. sign throws 'user rejected' → 'send_failed' with 'sign_rejected'
//   7. send 202 send_in_progress → 'in_progress'
//   8. send 410 → 'expired'
//   9. send 423 → 'manual_review'
//  10. send 500 → 'send_failed'
//  11. send 2xx body status='reverted' → 'reverted'
//  12. send 2xx body status='submitted' → 'submitted'
//  13. send 2xx body with unknown status → 'send_failed' with
//      'unexpected_send_status'
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const mockSignSafeOpHash = vi.fn();
// These fixtures are not real Safe operations; the browser's signing check (op-binding) has its own tests.
vi.mock('../op-binding', async (orig) => ({ ...(await orig<typeof import('@/lib/op-binding')>()), assertSignableOp: () => {} }));
vi.mock('../embedded-signer', () => ({
  signSafeOpHash: (...args: unknown[]) => mockSignSafeOpHash(...args),
}));

import { runPmClaim } from '../aa-client';

const PM_ADDRESS: Address = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const MAGIC_EOA: Address = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const MARKET_ID = 7n;
const CHAIN_ID = 10143;

const VALID_SPONSOR_RESPONSE = {
  pendingUserOpId: 'op-123',
  userOp: {
    sender: '0x' + '00'.repeat(20),
    nonce: '0x0',
    initCode: '0x',
    callData: '0x',
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    paymaster: '0x' + '00'.repeat(20),
    paymasterVerificationGasLimit: '0x0',
    paymasterPostOpGasLimit: '0x0',
    paymasterData: '0x',
  },
  safeOpHash: '0x' + 'aa'.repeat(32),
  userOpHash: '0x' + 'bb'.repeat(32),
  validAfter: '0x0',
  validUntil: '0xffffffffffff',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

interface QueuedResponse {
  ok?: boolean;
  status: number;
  body?: unknown;
  throws?: Error;
}

function queueFetchResponses(responses: QueuedResponse[]) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const r = responses[i++];
      if (!r) throw new Error(`fetch called more than ${responses.length} times`);
      if (r.throws) throw r.throws;
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  mockSignSafeOpHash.mockReset();
  mockSignSafeOpHash.mockResolvedValue(('0x' + '00'.repeat(77)) as Hex);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockSignSafeOpHash.mockReset();
});

const baseArgs = {
  chainId: CHAIN_ID,
  pmAddress: PM_ADDRESS,
  magicEoa: MAGIC_EOA,
  marketId: MARKET_ID,
};

describe('runSponsoredCallOp — happy path', () => {
  it('sponsor 200 → sign → send 200 sent → kind=sent', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      {
        status: 200,
        body: {
          status: 'sent',
          txHash: '0x' + 'cc'.repeat(32),
          userOpHash: '0x' + 'bb'.repeat(32),
        },
      },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('sent');
  });
});

describe('runSponsoredCallOp — sponsor failure branches', () => {
  it('sponsor 200 with missing safeOpHash → sponsor_failed sponsor_bad_response', async () => {
    queueFetchResponses([
      {
        status: 200,
        body: { ...VALID_SPONSOR_RESPONSE, safeOpHash: undefined },
      },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('sponsor_failed');
    if (outcome.kind === 'sponsor_failed') {
      expect(outcome.error).toBe('sponsor_bad_response');
    }
  });

  it('sponsor 200 with non-object body → sponsor_failed sponsor_bad_response', async () => {
    queueFetchResponses([{ status: 200, body: 'plain string body' }]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('sponsor_failed');
    if (outcome.kind === 'sponsor_failed') {
      expect(outcome.error).toBe('sponsor_bad_response');
    }
  });

  it('sponsor 500 error → sponsor_failed', async () => {
    queueFetchResponses([
      { status: 500, body: { error: 'INTERNAL', message: 'boom' } },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('sponsor_failed');
    if (outcome.kind === 'sponsor_failed') {
      expect(outcome.status).toBe(500);
      expect(outcome.error).toBe('INTERNAL');
      expect(outcome.detail).toBe('boom');
    }
  });

  it('sponsor fetch throw (transport error) → sponsor_failed sponsor_transport_failed', async () => {
    queueFetchResponses([
      { status: 0, throws: new Error('ECONNREFUSED') },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('sponsor_failed');
    if (outcome.kind === 'sponsor_failed') {
      expect(outcome.error).toBe('sponsor_transport_failed');
    }
  });
});

describe('runSponsoredCallOp — sign failure branch', () => {
  it('user-rejected sign → send_failed with sign_rejected', async () => {
    queueFetchResponses([{ status: 200, body: VALID_SPONSOR_RESPONSE }]);
    mockSignSafeOpHash.mockRejectedValueOnce(
      new Error('User rejected the request.'),
    );
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind === 'send_failed') {
      expect(outcome.error).toBe('sign_rejected');
    }
  });

  it('generic sign throw → send_failed with sign_failed', async () => {
    queueFetchResponses([{ status: 200, body: VALID_SPONSOR_RESPONSE }]);
    mockSignSafeOpHash.mockRejectedValueOnce(new Error('magic provider down'));
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind === 'send_failed') {
      expect(outcome.error).toBe('sign_failed');
    }
  });
});

describe('runSponsoredCallOp — send response branches', () => {
  it('send 202 send_in_progress → in_progress', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      {
        status: 202,
        body: { status: 'send_in_progress', retryAfterSeconds: 2 },
      },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('in_progress');
    if (outcome.kind === 'in_progress') {
      expect(outcome.retryAfterSeconds).toBe(2);
    }
  });

  it('send 410 → expired', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      { status: 410, body: { error: 'EXPIRED' } },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('expired');
  });

  it('send 423 → manual_review', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      { status: 423, body: { error: 'LOCKED' } },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('manual_review');
  });

  it('send 500 → send_failed', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      { status: 500, body: { error: 'INTERNAL', message: 'bundler down' } },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind === 'send_failed') {
      expect(outcome.status).toBe(500);
      expect(outcome.error).toBe('INTERNAL');
    }
  });

  it("send 2xx with status='reverted' → reverted", async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      {
        status: 200,
        body: {
          status: 'reverted',
          txHash: '0x' + 'dd'.repeat(32),
          userOpHash: '0x' + 'bb'.repeat(32),
          failureReason: 'on-chain revert',
        },
      },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('reverted');
  });

  it("send 2xx with status='submitted' → submitted", async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      {
        status: 200,
        body: {
          status: 'submitted',
          userOpHash: '0x' + 'bb'.repeat(32),
        },
      },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('submitted');
  });

  it('send 2xx with unknown status → send_failed unexpected_send_status', async () => {
    queueFetchResponses([
      { status: 200, body: VALID_SPONSOR_RESPONSE },
      { status: 200, body: { status: 'totally_made_up' } },
    ]);
    const outcome = await runPmClaim(baseArgs);
    expect(outcome.kind).toBe('send_failed');
    if (outcome.kind === 'send_failed') {
      expect(outcome.error).toBe('unexpected_send_status');
    }
  });
});
