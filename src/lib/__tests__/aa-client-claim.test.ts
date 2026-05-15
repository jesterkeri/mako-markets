// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-claim.test.ts
//
// claim-magic-parity r1 — Codex MIN-1 / MAJ-1 / MAJ-2 regression suite for
// the `runClaim` orchestrator. Mocks fetch + signSafeOpHash so the full
// sponsor → sign → send pipeline can be exercised without a live Magic
// session.
//
// Each scenario verifies that `runClaim` resolves a typed `RunOutcome`
// and NEVER throws past the caller — the contract `useClaim` depends
// on for its switch statement. Specifically:
//
//   - Happy path (`sent`, `submitted`, `reverted`, `failed_pre_submit`,
//     `expired`) — defensive structural pin.
//   - MAJ-1 — sponsor transport throw, sponsor 200 with missing
//     validity fields, sign throws (rejected vs network), send
//     transport throw.
//   - MAJ-2 — fetch returns 2xx with status 202 `send_in_progress`,
//     2xx with status 410 `expired`, 2xx with status 423
//     `manual_review`, 2xx with unrecognised body status (defensive
//     default surfacing as `send_failed unexpected_send_status`).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const mocks = vi.hoisted(() => ({
  signSafeOpHash: vi.fn(),
}));
vi.mock('../magic-browser', () => ({
  signSafeOpHash: (args: unknown) => mocks.signSafeOpHash(args),
}));

import { runClaim, type RunOutcome } from '../aa-client';
import { MONAD_TESTNET_ID } from '../chain';

const SAFE: Address = '0x000000000000000000000000000000000000beef';
const MAKO: Address = '0x000000000000000000000000000000000000ca11';
const MAGIC_EOA: Address = '0x000000000000000000000000000000000000ee0a';

type FetchResponse = { status: number; body: unknown };

function mkResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function sponsoredBodyStub(): Record<string, unknown> {
  return {
    pendingUserOpId: '00000000-0000-0000-0000-00000000aaaa',
    userOp: {
      sender: SAFE,
      nonce: '0x0',
      initCode: '0x',
      callData: '0xabcd',
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
    safeOpHash: '0x' + 'aa'.repeat(32),
    userOpHash: '0x' + 'bb'.repeat(32),
    validAfter: '0x0',
    validUntil: '0xffffffffffff',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

const ARGS = {
  chainId: MONAD_TESTNET_ID,
  makoAddress: MAKO,
  marketId: 7n,
  magicEoa: MAGIC_EOA,
};

describe('runClaim — orchestrator with mocked fetch + Magic', () => {
  const fetchQueue: FetchResponse[] = [];

  beforeEach(() => {
    fetchQueue.length = 0;
    mocks.signSafeOpHash.mockReset();
    vi.stubGlobal('fetch', async () => {
      const next = fetchQueue.shift();
      if (!next) {
        throw new Error('unexpected fetch');
      }
      return mkResponse(next.status, next.body);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function enqueue(response: FetchResponse): void {
    fetchQueue.push(response);
  }

  // ── Happy path ────────────────────────────────────────────────────

  it('happy path: sponsor + sign + send → sent', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 200,
      body: {
        status: 'sent',
        txHash: '0x' + 'cc'.repeat(32),
        userOpHash: '0x' + 'bb'.repeat(32),
      },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result: RunOutcome = await runClaim(ARGS);
    expect(result.kind).toBe('sent');
    if (result.kind !== 'sent') return;
    expect(result.txHash).toBe(('0x' + 'cc'.repeat(32)) as Hex);
  });

  // ── Codex r1 MAJ-1 paths ──────────────────────────────────────────

  it('MAJ-1: sponsor fetch throws → sponsor_failed sponsor_transport_failed', async () => {
    // No sponsor response enqueued; fetch throws via the unexpected-fetch
    // path in the global mock.
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.error).toBe('sponsor_transport_failed');
  });

  it('MAJ-1: sponsor non-2xx → sponsor_failed with route error code', async () => {
    enqueue({ status: 429, body: { error: 'CAP_EXCEEDED' } });
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.status).toBe(429);
    expect(result.error).toBe('CAP_EXCEEDED');
  });

  it('MAJ-1: sponsor 200 with missing validAfter → sponsor_failed sponsor_bad_response', async () => {
    const malformed = { ...sponsoredBodyStub() };
    delete (malformed as Record<string, unknown>).validAfter;
    enqueue({ status: 200, body: malformed });

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.error).toBe('sponsor_bad_response');
  });

  it('MAJ-1: sponsor 200 with null body → sponsor_failed sponsor_bad_response', async () => {
    enqueue({ status: 200, body: null });
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.error).toBe('sponsor_bad_response');
  });

  it('MAJ-1: sign throws (user rejected) → send_failed sign_rejected', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    mocks.signSafeOpHash.mockRejectedValueOnce(
      new Error('user rejected the request'),
    );
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_rejected');
  });

  it('MAJ-1: sign throws (network) → send_failed sign_failed', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    mocks.signSafeOpHash.mockRejectedValueOnce(
      new Error('network connection lost'),
    );
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_failed');
  });

  it('MAJ-1: sign throws on non-numeric validAfter → send_failed sign_failed', async () => {
    // Shape check passes (validAfter present, truthy), but BigInt()
    // coerces inside the sign try and throws.
    enqueue({
      status: 200,
      body: { ...sponsoredBodyStub(), validAfter: 'not-a-number' },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_failed');
  });

  it('MAJ-1: send fetch throws → send_failed send_transport_failed', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    // No send response enqueued; second fetch throws.
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('send_transport_failed');
  });

  // ── Codex r1 MAJ-2 paths ──────────────────────────────────────────

  it('MAJ-2: send 202 send_in_progress → in_progress (NOT undefined)', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 202,
      body: { status: 'send_in_progress', retryAfterSeconds: 3 },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('in_progress');
    if (result.kind !== 'in_progress') return;
    expect(result.retryAfterSeconds).toBe(3);
  });

  it('MAJ-2: send 410 → expired', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 410, body: { error: 'expired' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('expired');
  });

  it('MAJ-2: send 423 → manual_review', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 423, body: { error: 'manual_review' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('manual_review');
  });

  it('MAJ-2: send 200 with unrecognised body status → send_failed unexpected_send_status (NOT undefined)', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 200, body: { status: 'a_brand_new_status' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('unexpected_send_status');
  });

  it('MAJ-2: send 202 with non-matching body status → send_failed unexpected_202_body', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 202, body: { status: 'something_else' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('unexpected_202_body');
  });

  // ── Other send terminal states (regression pins) ─────────────────

  it('happy: send reverted → reverted', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 200,
      body: {
        status: 'reverted',
        txHash: '0x' + 'ee'.repeat(32),
        userOpHash: '0x' + 'bb'.repeat(32),
        failureReason: 'AlreadyClaimed',
      },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('reverted');
    if (result.kind !== 'reverted') return;
    expect(result.failureReason).toBe('AlreadyClaimed');
  });

  it('happy: send submitted (receipt poll timeout) → submitted', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 200,
      body: { status: 'submitted', userOpHash: '0x' + 'bb'.repeat(32) },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('submitted');
  });

  it('happy: send failed_pre_submit → failed_pre_submit', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 200,
      body: { status: 'failed_pre_submit', failureReason: 'AA23 reverted' },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('failed_pre_submit');
  });

  // ── Codex r2 MAJ-1: null-body regressions ─────────────────────────
  //
  // postJson resolves with body=null when the response has no JSON
  // body. Previously every body access (`(body as { ... }).field`)
  // would throw on `null.field`. r2 introduced isRecord +
  // readStringField + readNumberField helpers; these pin that the
  // four read sites no longer crash.

  it('MAJ-1 r2: sponsor non-2xx with NULL body → sponsor_failed unknown', async () => {
    enqueue({ status: 500, body: null });
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.status).toBe(500);
    expect(result.error).toBe('unknown');
    expect(result.reason).toBeUndefined();
    expect(result.detail).toBeUndefined();
  });

  it('MAJ-1 r2: sponsor 2xx with NULL body → sponsor_failed sponsor_bad_response', async () => {
    enqueue({ status: 200, body: null });
    const result = await runClaim(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.error).toBe('sponsor_bad_response');
  });

  it('MAJ-1 r2: send 202 with NULL body → send_failed unexpected_202_body', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 202, body: null });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.status).toBe(202);
    expect(result.error).toBe('unexpected_202_body');
  });

  it('MAJ-1 r2: send non-2xx with NULL body → send_failed unknown', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 502, body: null });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.status).toBe(502);
    expect(result.error).toBe('unknown');
    expect(result.detail).toBeUndefined();
  });

  it('MAJ-1 r2: send 200 with NULL body → send_failed unexpected_send_status', async () => {
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 200, body: null });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runClaim(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('unexpected_send_status');
  });
});
