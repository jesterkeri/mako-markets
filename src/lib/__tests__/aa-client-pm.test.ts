// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-pm.test.ts
//
// Phase 2C-1 — browser-side PM helpers + cross-module pins:
//
//   1. generateClientNonce: shape, uniqueness, error on missing Web Crypto.
//   2. shapeEnumToString: round-trip mapping + throw on unknown.
//   3. Cross-module pin: callData encoded by runCreatePrivateMarket's
//      internal logic round-trips cleanly through
//      assertPmCreateMarketShape (the server-side validator). Proves
//      client/server agree on the createMarket ABI tuple.
//
// The orchestrator's full HTTP/Magic happy path is covered by the
// manual smoke in step 13 (mandatory SQL row check). Mocking fetch +
// Magic for an e2e test adds boilerplate without catching anything
// the cross-module pin doesn't already catch.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionData,
  toHex,
  type Address,
  type Hex,
} from 'viem';

// Server-side treasury accessor is not used by the helpers under test,
// but importing aa-call-allowlist transitively loads it. Mock to a
// noop so the test doesn't need treasury env vars. Mock magic-browser
// too — runCreatePrivateMarket calls signSafeOpHash; we want a stub.
const mocks = vi.hoisted(() => ({
  getPmTreasuryAddress: vi.fn(),
  signSafeOpHash: vi.fn(),
}));
vi.mock('@/lib/private-markets/treasury', () => ({
  getPmTreasuryAddress: () => mocks.getPmTreasuryAddress(),
}));
// These fixtures are not real Safe operations; the browser's signing check (op-binding) has its own tests.
vi.mock('../op-binding', async (orig) => ({ ...(await orig<typeof import('@/lib/op-binding')>()), assertSignableOp: () => {} }));
vi.mock('../embedded-signer', () => ({
  signSafeOpHash: (args: unknown) => mocks.signSafeOpHash(args),
}));

import {
  generateClientNonce,
  hasPmDraftRef,
  runCreatePrivateMarket,
  shapeEnumToString,
  type RunOutcome,
} from '../aa-client';
import { assertPmCreateMarketShape } from '../aa-call-allowlist';
import { PM_CONTRACT_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import {
  PM_CREATE_MARKET_ABI,
  type PmCreateParamsTuple,
} from '../private-markets/abi-fragments';

const SAFE: Address = '0x000000000000000000000000000000000000beef';
const TREASURY: Address = '0x000000000000000000000000000000000000c0de';
const WALLET_A: Address = '0x0000000000000000000000000000000000000001';
const WALLET_B: Address = '0x0000000000000000000000000000000000000002';

// ── generateClientNonce ─────────────────────────────────────────────────────

describe('generateClientNonce', () => {
  it('returns a 0x-prefixed 32-byte (66-char) hex string', () => {
    const nonce = generateClientNonce();
    expect(nonce.startsWith('0x')).toBe(true);
    expect(nonce.length).toBe(66); // '0x' + 64 hex chars
    expect(/^0x[0-9a-f]{64}$/.test(nonce)).toBe(true);
  });

  it('produces distinct values on consecutive calls (uniqueness sanity)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateClientNonce());
    }
    expect(seen.size).toBe(100);
  });

  it('throws a clear error when Web Crypto is unavailable', () => {
    // Stash + remove globalThis.crypto for this test.
    const original = globalThis.crypto;
    delete (globalThis as Record<string, unknown>).crypto;
    try {
      expect(() => generateClientNonce()).toThrow(/Web Crypto API unavailable/);
    } finally {
      // Restore so subsequent tests don't break.
      Object.defineProperty(globalThis, 'crypto', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

// ── shapeEnumToString ───────────────────────────────────────────────────────

describe('shapeEnumToString', () => {
  it('maps 0 → friendly', () => {
    expect(shapeEnumToString(0)).toBe('friendly');
  });
  it('maps 1 → open_vote', () => {
    expect(shapeEnumToString(1)).toBe('open_vote');
  });
  it('maps 2 → prize_pool', () => {
    expect(shapeEnumToString(2)).toBe('prize_pool');
  });
  it('throws on unknown shape (defensive cast escape)', () => {
    expect(() =>
      shapeEnumToString(3 as unknown as 0 | 1 | 2),
    ).toThrow(/unknown PM shape 3/);
  });
});

// ── Cross-module pin: client encoding round-trips through server validator ──

describe('runCreatePrivateMarket — cross-module ABI pin', () => {
  // The orchestrator builds callData with PM_CREATE_MARKET_ABI and the
  // sponsor route validates it with the same ABI via
  // assertPmCreateMarketShape. This test mimics the encoding step
  // EXACTLY as the helper does it (same ABI, same args shape) and
  // hands the result to the server validator. If anything drifts —
  // ABI field order, tuple type, selector — this fires loudly.

  function fixtureParamsWithNonce(): PmCreateParamsTuple {
    return {
      shape: 0, // Friendly
      stakingOpensAt: 1_800_000_060n,
      closeAt: 1_800_003_600n,
      title: toHex('Will it rain?'),
      description: toHex(''),
      streamUrl: toHex(''),
      optionLabels: [toHex('NO'), toHex('YES')],
      participantWallets: [],
      allowlist: [],
      viewMode: 1,
      participationMode: 0,
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 0,
      clientNonce: generateClientNonce(),
    };
  }

  it('callData encoded by the helper passes assertPmCreateMarketShape', () => {
    const params = fixtureParamsWithNonce();

    // Same encoding the helper performs internally — pinned here so
    // any drift in PM_CREATE_MARKET_ABI shape vs the helper's call
    // surfaces immediately.
    const callData = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [params],
    });

    // Server-side validator accepts it.
    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: callData },
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });

  it('PrizePool variant round-trips (different shape, different fields)', () => {
    const params: PmCreateParamsTuple = {
      ...fixtureParamsWithNonce(),
      shape: 2, // PrizePool
      optionLabels: [toHex('Alice'), toHex('Bob')],
      participantWallets: [WALLET_A, WALLET_B],
      winnersCount: 1,
      title: toHex('Top performer'),
    };

    const callData = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [params],
    });

    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: callData },
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });

  // Codex 2C-1 step-11 r1 MIN-1: OpenVote round-trip. OpenVote is the
  // only shape where fixedStake is non-zero, so this catches a
  // tuple-order drift around fixedStake that Friendly/PrizePool
  // wouldn't surface (both have fixedStake=0).
  it('OpenVote variant round-trips (non-zero fixedStake)', () => {
    const params: PmCreateParamsTuple = {
      ...fixtureParamsWithNonce(),
      shape: 1, // OpenVote
      optionLabels: [toHex('A'), toHex('B'), toHex('C')],
      fixedStake: 50_000n, // non-zero — only OpenVote uses it
      winnersCount: 1,
      title: toHex('Pick a winner'),
    };

    const callData = encodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      functionName: 'createMarket',
      args: [params],
    });

    expect(
      assertPmCreateMarketShape({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: { to: PM_CONTRACT_ADDRESS, value: 0n, data: callData },
        treasury: TREASURY,
      }),
    ).toBeUndefined();
  });
});

// ── runCreatePrivateMarket orchestrator (Codex r1 MAJ-2) ────────────────────
//
// Mocks fetch and signSafeOpHash so the full draft → sponsor → sign →
// send pipeline can be exercised. Caught the r1 MAJ-1 202-fallthrough
// bug before it would have surfaced as a UI hang.

// Codex r2 NIT-1: `ok` is derived from `status`, not declared on the
// fixture — kept the type minimal.
type FetchResponse = {
  status: number;
  body: unknown;
};

function mkResponse(status: number, body: unknown): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface QueuedFetch {
  url: string;
  body: unknown;
  response: FetchResponse;
}

describe('runCreatePrivateMarket — orchestrator with mocked fetch + Magic', () => {
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const fetchQueue: FetchResponse[] = [];

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchQueue.length = 0;
    mocks.signSafeOpHash.mockReset();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      fetchCalls.push({ url, body });
      const next = fetchQueue.shift();
      if (!next) {
        throw new Error(`unexpected fetch: ${url}`);
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

  // Phase 2C-2 step 11b: shared draft-response stub. Every post-draft
  // outcome of runCreatePrivateMarket must surface { slug, clientNonce,
  // pendingDbId } as `pmDraft` so the /create/private UI can deep-link
  // `/m/<slug>` on failure paths. Keeping the fixture in one place
  // means a future field addition to PmDraftRef touches one stub, not
  // eight tests.
  const DRAFT_SLUG = 'ABCD1234';
  const DRAFT_PENDING_ID = '00000000-0000-0000-0000-00000000d1ff';
  const DRAFT_NONCE = ('0x' + 'cd'.repeat(32)) as Hex;
  function draftBodyStub(): Record<string, unknown> {
    return {
      slug: DRAFT_SLUG,
      clientNonce: DRAFT_NONCE,
      pendingDbId: DRAFT_PENDING_ID,
    };
  }

  /// Assert that an outcome's pmDraft matches what the draft route
  /// returned. Called from every post-draft outcome test below.
  function expectPmDraftMatchesStub(outcome: RunOutcome): void {
    const ref = (outcome as { pmDraft?: { slug?: string; clientNonce?: Hex; pendingDbId?: string } }).pmDraft;
    expect(ref).toBeDefined();
    expect(ref?.slug).toBe(DRAFT_SLUG);
    expect(ref?.clientNonce).toBe(DRAFT_NONCE);
    expect(ref?.pendingDbId).toBe(DRAFT_PENDING_ID);
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
    magicEoa: '0x2222222222222222222222222222222222222222' as Address,
    commentsEnabled: true,
    createParams: {
      shape: 0 as const,
      stakingOpensAt: 1_800_000_060n,
      closeAt: 1_800_003_600n,
      title: toHex('Will it rain?'),
      description: toHex(''),
      streamUrl: toHex(''),
      optionLabels: [toHex('NO'), toHex('YES')],
      participantWallets: [] as Address[],
      allowlist: [] as Address[],
      viewMode: 1 as const,
      participationMode: 0 as const,
      perStakeMin: 0n,
      perStakeMax: 0n,
      perWalletCumulativeMax: 0n,
      fixedStake: 0n,
      winnersCount: 0,
    },
  };

  it('happy path: draft + sponsor + sign + send → sent', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
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

    const result = await runCreatePrivateMarket(ARGS);

    expect(result.kind).toBe('sent');
    if (result.kind !== 'sent') return;
    expect(result.txHash).toBe(('0x' + 'cc'.repeat(32)) as Hex);
    expectPmDraftMatchesStub(result);

    // Verify call sequence: draft, sponsor, send.
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0].url).toBe('/api/pm/markets/draft');
    expect(fetchCalls[1].url).toBe('/api/aa/sponsor');
    expect(fetchCalls[2].url).toBe('/api/aa/send');

    // Verify draft body shape — chainId, contractAddress, shape (mapped),
    // clientNonce (generated, 32-byte hex).
    const draftBody = fetchCalls[0].body as Record<string, unknown>;
    expect(draftBody.chainId).toBe(MONAD_TESTNET_ID);
    expect(draftBody.contractAddress).toBe(PM_CONTRACT_ADDRESS);
    expect(draftBody.shape).toBe('friendly'); // mapped from shape=0
    expect(typeof draftBody.clientNonce).toBe('string');
    expect(/^0x[0-9a-f]{64}$/.test(draftBody.clientNonce as string)).toBe(true);
    // #182 Slice B: the off-chain comments toggle rides the draft body.
    expect(draftBody.commentsEnabled).toBe(true);

    // Verify sponsor body shape — kind=pm_create_market.
    const sponsorBody = fetchCalls[1].body as Record<string, unknown>;
    expect(sponsorBody.kind).toBe('pm_create_market');
    expect(sponsorBody.chainId).toBe(MONAD_TESTNET_ID);
    const call = sponsorBody.call as Record<string, unknown>;
    expect(call.to).toBe(PM_CONTRACT_ADDRESS);
    expect(call.value).toBe('0x0');

    // Codex r2 MIN-2: prove the clientNonce sent to /api/pm/markets/
    // draft is the SAME nonce encoded into the createMarket call.
    // A regression that generated nonce A for /draft and encoded
    // nonce B in createMarket would still pass with the mocked
    // sponsor endpoint here, but would fail the draft gate in
    // production (creator/shape lookup keyed on client_nonce).
    const decoded = decodeFunctionData({
      abi: PM_CREATE_MARKET_ABI,
      data: call.data as Hex,
    });
    const decodedParams = (decoded.args as readonly [PmCreateParamsTuple])[0];
    expect(decodedParams.clientNonce).toBe(draftBody.clientNonce);

    // signSafeOpHash invoked once with the sponsor's safeOpHash.
    expect(mocks.signSafeOpHash).toHaveBeenCalledTimes(1);
  });

  it('draft failure → sponsor_failed with step="draft" (no sponsor / sign / send calls)', async () => {
    enqueue({
      status: 409,
      body: { error: 'pm_draft_duplicate' },
    });

    const result = await runCreatePrivateMarket(ARGS);

    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.step).toBe('draft');
    expect(result.status).toBe(409);
    expect(result.error).toBe('pm_draft_duplicate');

    // Phase 2C-2 step 11b: step='draft' outcomes do NOT carry pmDraft
    // (the slug was never reserved). UI must not deep-link /m/<slug>
    // in this case.
    expect(result.pmDraft).toBeUndefined();

    // Only 1 fetch — draft. No sponsor / send.
    expect(fetchCalls).toHaveLength(1);
    expect(mocks.signSafeOpHash).not.toHaveBeenCalled();
  });

  it('sponsor failure → sponsor_failed with step="sponsor" (no sign / send calls)', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({
      status: 403,
      body: { error: 'NOT_ALLOWED', reason: 'pm_draft_wrong_creator' },
    });

    const result = await runCreatePrivateMarket(ARGS);

    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.step).toBe('sponsor');
    expect(result.status).toBe(403);
    expect(result.reason).toBe('pm_draft_wrong_creator');
    expectPmDraftMatchesStub(result);

    expect(fetchCalls).toHaveLength(2); // draft + sponsor, no send
    expect(mocks.signSafeOpHash).not.toHaveBeenCalled();
  });

  // Codex r1 MAJ-1 regression: 202 send_in_progress must NOT fall
  // through to undefined. The pre-fix code's `if (!send.ok)` block
  // was unreachable for 2xx, so 202 hit the success-switch which
  // has no 'send_in_progress' case.
  it('send 202 → kind="in_progress" (Codex r1 MAJ-1 regression pin)', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({
      status: 202,
      body: { status: 'send_in_progress', retryAfterSeconds: 3 },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result: RunOutcome = await runCreatePrivateMarket(ARGS);

    expect(result.kind).toBe('in_progress');
    if (result.kind !== 'in_progress') return;
    expect(result.retryAfterSeconds).toBe(3);
    expectPmDraftMatchesStub(result);
  });

  it('send 410 → kind="expired"', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 410, body: { error: 'expired' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('expired');
    expectPmDraftMatchesStub(result);
  });

  it('send 423 → kind="manual_review"', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 423, body: { error: 'manual_review' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('manual_review');
    expectPmDraftMatchesStub(result);
  });

  // Codex r2 MIN-1: regression for the defensive default in the
  // success switch. A 200 response with an unrecognised status (or
  // missing status) must NOT fall through to undefined.
  it('send 200 with unexpected status → kind="send_failed" (Codex r2 MIN-1)', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 200, body: { status: 'wat' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('unexpected_send_status');
    expect(result.detail).toContain('wat');
    expectPmDraftMatchesStub(result);
  });

  it('send 200 with NO status field → kind="send_failed"', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 200, body: {} });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('unexpected_send_status');
    expectPmDraftMatchesStub(result);
  });

  it('send 5xx → kind="send_failed"', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 502, body: { error: 'bundler_unreachable' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.status).toBe(502);
    expect(result.error).toBe('bundler_unreachable');
    expectPmDraftMatchesStub(result);
  });

  // Phase 2C-2 step 11b: hasPmDraftRef type guard narrows correctly
  // for downstream UI usage. The guard is exported from aa-client so
  // the /create/private page can deep-link `/m/<slug>` from any
  // post-draft outcome without optional chaining.
  it('hasPmDraftRef narrows the outcome type after a post-draft failure', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    enqueue({ status: 410, body: { error: 'expired' } });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(hasPmDraftRef(result)).toBe(true);
    if (!hasPmDraftRef(result)) return;
    // After the guard, `result.pmDraft` is non-optional.
    expect(result.pmDraft.slug).toBe(DRAFT_SLUG);
  });

  it('hasPmDraftRef returns false on step="draft" outcomes', async () => {
    enqueue({
      status: 409,
      body: { error: 'pm_draft_duplicate' },
    });

    const result = await runCreatePrivateMarket(ARGS);
    expect(hasPmDraftRef(result)).toBe(false);
  });

  // ── Codex r2 MAJ-1: post-draft transport throws preserve pmDraft ─────
  //
  // Each helper resolves to a typed RunOutcome — never throws — after
  // /api/pm/markets/draft has succeeded. Tests force fetch / Magic
  // signer to throw and assert pmDraft is attached so the UI can
  // deep-link /m/<slug> for retry/recovery.

  it('sponsor fetch throws → sponsor_failed step=sponsor with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    // Don't enqueue a sponsor response — let the unstubbed fetch throw
    // via the "unexpected fetch" path in the global mock. But the
    // mock throws synchronously inside the fetch impl; that throw IS
    // what we're simulating (transport / network failure).

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.step).toBe('sponsor');
    expect(result.error).toBe('sponsor_transport_failed');
    expectPmDraftMatchesStub(result);
  });

  it('Magic sign throws (user rejected) → send_failed sign_rejected with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    mocks.signSafeOpHash.mockRejectedValueOnce(
      new Error('user rejected the request'),
    );

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_rejected');
    expectPmDraftMatchesStub(result);
  });

  it('Magic sign throws (network) → send_failed sign_failed with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    mocks.signSafeOpHash.mockRejectedValueOnce(
      new Error('network connection lost'),
    );

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_failed');
    expectPmDraftMatchesStub(result);
  });

  it('send fetch throws → send_failed send_transport_failed with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: sponsoredBodyStub() });
    // Sign succeeds; no third response enqueued — fetch on send
    // throws via the "unexpected fetch" path.
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('send_transport_failed');
    expectPmDraftMatchesStub(result);
  });

  it('draft fetch throws → sponsor_failed step=draft with NO pmDraft', async () => {
    // No draft response enqueued.
    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.step).toBe('draft');
    expect(result.error).toBe('draft_transport_failed');
    // Pre-draft failure: pmDraft must be absent.
    expect(hasPmDraftRef(result)).toBe(false);
  });

  // ── Codex r3 MAJ-1: malformed sponsor 200 body ────────────────────────
  //
  // A sponsor response that's 200 OK but missing validAfter/validUntil
  // (or null body) used to throw via BigInt(undefined) outside the
  // sign try/catch, propagating past pmDraft. The helper now validates
  // the shape before any BigInt coercion and returns sponsor_failed
  // with pmDraft attached.

  it('sponsor 200 with missing validAfter → sponsor_failed sponsor_bad_response with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    const malformed = { ...sponsoredBodyStub() };
    delete (malformed as Record<string, unknown>).validAfter;
    enqueue({ status: 200, body: malformed });

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.step).toBe('sponsor');
    expect(result.error).toBe('sponsor_bad_response');
    expectPmDraftMatchesStub(result);
  });

  it('sponsor 200 with null body → sponsor_failed sponsor_bad_response with pmDraft', async () => {
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({ status: 200, body: null });

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('sponsor_failed');
    if (result.kind !== 'sponsor_failed') return;
    expect(result.error).toBe('sponsor_bad_response');
    expectPmDraftMatchesStub(result);
  });

  it('sponsor 200 with non-numeric validAfter → send_failed sign_failed with pmDraft', async () => {
    // Shape check passes (field present), but BigInt() throws on a
    // non-numeric string. Caught inside the sign try.
    enqueue({ status: 200, body: draftBodyStub() });
    enqueue({
      status: 200,
      body: { ...sponsoredBodyStub(), validAfter: 'not-a-number' },
    });
    mocks.signSafeOpHash.mockResolvedValueOnce('0x' + 'dd'.repeat(77));

    const result = await runCreatePrivateMarket(ARGS);
    expect(result.kind).toBe('send_failed');
    if (result.kind !== 'send_failed') return;
    expect(result.error).toBe('sign_failed');
    expectPmDraftMatchesStub(result);
  });
});
