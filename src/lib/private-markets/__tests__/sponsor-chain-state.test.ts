// ----------------------------------------------------------------------------
// src/lib/private-markets/__tests__/sponsor-chain-state.test.ts
//
// Phase 2E-1 slice B tests.
//
//   1. PmMarketState enum mirror pins every numeric value emitted by
//      `MarketView.effectiveState` / `.storedState`. Plan v8 MIN-2: the
//      `Open`, `AwaitingCreator`, `TimedOut`, and `ZeroStakeExpired`
//      states are LAZY (never written to storage); the pin asserts the
//      ABI enum value, not storage.
//
//   2. readSponsorMarketState dispatches via a mocked viem PublicClient
//      and verifies the cache, success decode, and three failure
//      buckets:
//        - getMarket per-call failure → market_not_found
//        - multicall throws            → pm_state_rpc_failure
//        - other per-call failure with getMarket success
//                                       → pm_bad_state_shape_unknown
//        - unknown enum value          → pm_bad_state_shape_unknown
//
//   3. Address normalization (Plan v8 MAJ-1): viem returns the creator
//      in checksummed casing; the cached snapshot must surface the
//      lowercase form so validators can use `===` directly against
//      a normalized safeAddress.
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockMulticall = vi.fn();

vi.mock('@/lib/aa-public-client', () => ({
  getAaPublicClient: () => ({
    multicall: mockMulticall,
  }),
}));

import {
  PmMarketState,
  createSponsorMarketStateCache,
  readSponsorMarketState,
} from '../sponsor-chain-state';
import { MONAD_TESTNET_ID } from '@/lib/chain';

const MARKET_ID = 42n;
const CREATOR_CHECKSUMMED =
  '0xC8BF886f0123456789abCDef0123456789ABcdEF' as const;
const CREATOR_LOWER = CREATOR_CHECKSUMMED.toLowerCase();

const ALLOWLIST_CHECKSUMMED = [
  '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa',
  '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb',
] as const;
const PARTICIPANTS_CHECKSUMMED = [
  '0xCCCCccccCCCCccccCCCCccccCCCCccccCCCCcccc',
] as const;
const OPTIONS_RAW = ['0xaabb', '0xccdd'] as const;

function makeMarketView(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    creator: CREATOR_CHECKSUMMED,
    shape: 0,
    clientNonce:
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    createdAt: 1_700_000_000n,
    stakingOpensAt: 1_700_000_100n,
    closeAt: 1_700_000_200n,
    viewMode: 1,
    participationMode: 0,
    storedState: PmMarketState.Created,
    effectiveState: PmMarketState.Open,
    perStakeMin: 0n,
    perStakeMax: 0n,
    perWalletCumulativeMax: 0n,
    fixedStake: 0n,
    winnersCount: 0,
    totalStake: 100n,
    friendlyOutcome: 0,
    friendlyEmptyPoolPath: false,
    feeTaken: 0n,
    dust: 0n,
    metadataFrozenEmitted: false,
    ...overrides,
  };
}

function happyMulticallReturn(viewOverrides = {}) {
  return [
    { status: 'success', result: makeMarketView(viewOverrides) },
    { status: 'success', result: OPTIONS_RAW },
    { status: 'success', result: ALLOWLIST_CHECKSUMMED },
    { status: 'success', result: PARTICIPANTS_CHECKSUMMED },
  ];
}

beforeEach(() => {
  mockMulticall.mockReset();
});

afterEach(() => {
  mockMulticall.mockReset();
});

// ── PmMarketState enum mirror pins ─────────────────────────────────────────

describe('PmMarketState enum mirror', () => {
  // Pins every ABI enum numeric value emitted by MarketView.effectiveState
  // and MarketView.storedState. The hardcoded literals MUST match the
  // contract enum order in MakoPrivateMarketsV1.sol lines 54-62.
  it('Created matches MarketView.effectiveState ABI value 0', () => {
    expect(PmMarketState.Created).toBe(0);
  });
  it('Open matches MarketView.effectiveState ABI value 1', () => {
    // lazy-only state; never lives in storage. Pinned via the
    // MarketView.effectiveState slot.
    expect(PmMarketState.Open).toBe(1);
  });
  it('AwaitingCreator matches MarketView.effectiveState ABI value 2', () => {
    // lazy-only state; never lives in storage. Pinned via the
    // MarketView.effectiveState slot for a market in the lazy
    // AwaitingCreator window.
    expect(PmMarketState.AwaitingCreator).toBe(2);
  });
  it('Resolved matches MarketView.effectiveState ABI value 3', () => {
    expect(PmMarketState.Resolved).toBe(3);
  });
  it('EmptyPoolResolved matches MarketView.effectiveState ABI value 4', () => {
    expect(PmMarketState.EmptyPoolResolved).toBe(4);
  });
  it('Canceled matches MarketView.effectiveState ABI value 5', () => {
    expect(PmMarketState.Canceled).toBe(5);
  });
  it('TimedOut matches MarketView.effectiveState ABI value 6', () => {
    // lazy-only state; never lives in storage.
    expect(PmMarketState.TimedOut).toBe(6);
  });
  it('ZeroStakeExpired matches MarketView.effectiveState ABI value 7', () => {
    // lazy-only state; never lives in storage.
    expect(PmMarketState.ZeroStakeExpired).toBe(7);
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────

describe('readSponsorMarketState — happy path', () => {
  it('returns ok=true with normalized state on full success', async () => {
    mockMulticall.mockResolvedValueOnce(happyMulticallReturn());
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // satisfy type narrowing
    expect(result.state.creator).toBe(CREATOR_LOWER);
    expect(result.state.shape).toBe(0);
    expect(result.state.storedState).toBe(PmMarketState.Created);
    expect(result.state.effectiveState).toBe(PmMarketState.Open);
    expect(result.state.totalStake).toBe(100n);
    expect(result.state.allowlist).toEqual([
      ALLOWLIST_CHECKSUMMED[0].toLowerCase(),
      ALLOWLIST_CHECKSUMMED[1].toLowerCase(),
    ]);
    expect(result.state.participants).toEqual([
      PARTICIPANTS_CHECKSUMMED[0].toLowerCase(),
    ]);
    expect(result.state.options).toEqual(OPTIONS_RAW);
  });

  it('serves the cached result on a second call for the same marketId', async () => {
    mockMulticall.mockResolvedValueOnce(happyMulticallReturn());
    const cache = createSponsorMarketStateCache();

    const first = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });
    const second = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(mockMulticall).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same reference => cache hit
  });

  it('does not collide on different marketIds in the same cache', async () => {
    mockMulticall
      .mockResolvedValueOnce(
        happyMulticallReturn({ totalStake: 100n }),
      )
      .mockResolvedValueOnce(
        happyMulticallReturn({ totalStake: 200n }),
      );
    const cache = createSponsorMarketStateCache();

    const a = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: 1n,
      cache,
    });
    const b = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: 2n,
      cache,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) expect(a.state.totalStake).toBe(100n);
    if (b.ok) expect(b.state.totalStake).toBe(200n);
    expect(mockMulticall).toHaveBeenCalledTimes(2);
  });
});

// ── Failure buckets ────────────────────────────────────────────────────────

describe('readSponsorMarketState — failure buckets', () => {
  it('returns market_not_found when getMarket per-call status is failure', async () => {
    mockMulticall.mockResolvedValueOnce([
      { status: 'failure', error: new Error('MarketUnknown') },
      { status: 'failure' },
      { status: 'failure' },
      { status: 'failure' },
    ]);
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('market_not_found');
  });

  it('returns pm_state_rpc_failure when multicall throws (transport error)', async () => {
    mockMulticall.mockRejectedValueOnce(new Error('ECONNRESET'));
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pm_state_rpc_failure');
  });

  it('returns pm_bad_state_shape_unknown when getMarket succeeds but a side view fails', async () => {
    mockMulticall.mockResolvedValueOnce([
      { status: 'success', result: makeMarketView() },
      { status: 'failure', error: new Error('options revert') },
      { status: 'success', result: ALLOWLIST_CHECKSUMMED },
      { status: 'success', result: PARTICIPANTS_CHECKSUMMED },
    ]);
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pm_bad_state_shape_unknown');
  });

  it('returns pm_bad_state_shape_unknown when shape enum is out of range', async () => {
    mockMulticall.mockResolvedValueOnce(
      happyMulticallReturn({ shape: 99 }),
    );
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pm_bad_state_shape_unknown');
  });

  it('returns pm_bad_state_shape_unknown when effectiveState enum is out of range', async () => {
    mockMulticall.mockResolvedValueOnce(
      happyMulticallReturn({ effectiveState: 42 }),
    );
    const cache = createSponsorMarketStateCache();

    const result = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pm_bad_state_shape_unknown');
  });

  it('returns pm_state_rpc_failure for a chainId outside MONAD_TESTNET_ID', async () => {
    const cache = createSponsorMarketStateCache();
    const result = await readSponsorMarketState({
      // cast through unknown — runtime guard rejects, even though the
      // type narrows to MONAD_TESTNET_ID only.
      chainId: 9999 as unknown as typeof MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('pm_state_rpc_failure');
    expect(mockMulticall).not.toHaveBeenCalled();
  });

  it('caches failure results so a retried call doesn’t hammer the RPC', async () => {
    mockMulticall.mockRejectedValueOnce(new Error('ECONNRESET'));
    const cache = createSponsorMarketStateCache();

    const first = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });
    const second = await readSponsorMarketState({
      chainId: MONAD_TESTNET_ID,
      marketId: MARKET_ID,
      cache,
    });

    expect(first).toBe(second);
    expect(mockMulticall).toHaveBeenCalledTimes(1);
  });
});
