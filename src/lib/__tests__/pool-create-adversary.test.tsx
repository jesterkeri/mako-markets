// Adversary pass on the create page (10a), spec mako-design/REDESIGN_10A_CREATE_SPEC.md.
//
// 1. Rule 7: the "live" step must link only to the pool THIS create made. An email account's create lands inside a
//    bundler transaction (Pimlico handleOps), and one handleOps transaction can carry several user operations from
//    different Safes. The receipt fixture below is built with the repo's own ABI (MakoMarkets.abi.ts) and viem's
//    encoders: another creator's MarketCreated first, ours second, both from MAKO_ADDRESS, as a two-op bundle emits.
// 2. Rule 1: every pool the page can make must parse in the resolver (cf-worker/src/index.ts, whose parser is not
//    exported on this branch, so its strike pattern is quoted below) to the market the creator was shown. A forex, commodities or stocks target the input accepts ("0.0000001", or
//    22 digits) stringifies with an exponent, which parsePriceFeedOracleRef refuses.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { encodeAbiParameters, encodeEventTopics, type Hex, type TransactionReceipt } from 'viem';

const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const OTHER_SAFE = '0xdddddddddddddddddddddddddddddddddddddddd' as const;
const BUNDLE_TX = ('0x' + '11'.repeat(32)) as Hex;

const mocks = vi.hoisted(() => ({
  receipt: null as unknown,
  runSponsoredRequest: vi.fn(),
}));

vi.mock('../use-user', () => ({
  useUser: () => ({
    user: {
      authed: true,
      authType: 'magic',
      email: 'a@b.c',
      magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      safeAddress: SAFE,
      displayName: null,
      avatarUrl: null,
      totpEnabled: false,
      totpEnabledAt: null,
      lastSignInAt: null,
      nextEmailChangeAvailableAt: null,
    },
    isLoading: false,
  }),
}));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useChainId: () => 10143,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn(), data: undefined, isPending: false, error: null, reset: vi.fn() }),
  usePublicClient: () => ({
    // The Safe's allowance already covers the seed, so the single-call body is built.
    readContract: vi.fn(async () => 10n ** 30n),
    getTransactionReceipt: vi.fn(async () => mocks.receipt),
    waitForTransactionReceipt: vi.fn(async () => mocks.receipt),
  }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useReadContracts: () => ({ data: undefined, isLoading: false, error: null }),
}));

vi.mock('../hooks', () => ({ useEnsureMonadChain: () => async () => undefined }));

vi.mock('../aa-client', async () => {
  const actual = await vi.importActual<typeof import('../aa-client')>('../aa-client');
  return { ...actual, runSponsoredRequest: (...args: unknown[]) => mocks.runSponsoredRequest(...args) };
});

import { createdMarketIdFor, MAKO_ADDRESS, makoAbi } from '../contract';
import { toBytes32 } from '../oracle';
import { buildPool } from '../pool-create';
import { usePoolTx } from '../use-pool-tx';

/// One MarketCreated log from MAKO_ADDRESS, encoded with the contract's ABI.
function marketCreatedLog(id: bigint, creator: `0x${string}`, logIndex: number) {
  const topics = encodeEventTopics({ abi: makoAbi, eventName: 'MarketCreated', args: { id, creator } });
  const data = encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint64' }, { type: 'string' }],
    [0, toBytes32('BTC:gt:100000'), 1_800_003_660n, 'Will BTC close above $100,000 in 1 hour?'],
  );
  return { address: MAKO_ADDRESS, topics, data, logIndex, blockNumber: 1n, blockHash: BUNDLE_TX, transactionHash: BUNDLE_TX, transactionIndex: 0, removed: false };
}

afterEach(() => {
  cleanup();
  mocks.runSponsoredRequest.mockReset();
});

describe('rule 7: the live step names the pool this create made', () => {
  it('reads our pool id, not the first MarketCreated in a two-op bundle', async () => {
    // Another Safe's create was bundled ahead of ours in the same handleOps transaction.
    mocks.receipt = {
      transactionHash: BUNDLE_TX,
      status: 'success',
      logs: [marketCreatedLog(90n, OTHER_SAFE, 0), marketCreatedLog(91n, SAFE, 1)],
    } as unknown as TransactionReceipt;
    mocks.runSponsoredRequest.mockResolvedValue({ kind: 'sent', pendingUserOpId: 'p1', txHash: BUNDLE_TX, userOpHash: ('0x' + '22'.repeat(32)) as Hex });

    const { result } = renderHook(() => usePoolTx());
    act(() => {
      result.current.open({ kind: 'create', draft: { kind: 'crypto', symbol: 'BTC', direction: 'above', strike: 100000, durationSec: 3600 }, seed: 1_000_000n, seedYes: true });
    });
    await act(async () => {
      await result.current.confirm();
    });

    expect(mocks.runSponsoredRequest).toHaveBeenCalledTimes(1);
    expect(result.current.phase.step).toBe('done');
    // Pool 90 belongs to OTHER_SAFE; the creator's own pool is 91.
    expect(result.current.createdId).toBe(91n);
  });
});

describe('createdMarketIdFor', () => {
  const receipt = (logs: ReturnType<typeof marketCreatedLog>[]) => ({ transactionHash: BUNDLE_TX, status: 'success', logs }) as unknown as TransactionReceipt;

  it('ignores a look-alike MarketCreated from another contract', () => {
    const fake = { ...marketCreatedLog(7n, SAFE, 0), address: OTHER_SAFE };
    expect(createdMarketIdFor(receipt([fake, marketCreatedLog(91n, SAFE, 1)]), SAFE)).toBe(91n);
    expect(createdMarketIdFor(receipt([fake]), SAFE)).toBeNull();
  });

  it('names no pool when the account made two in one transaction, or none', () => {
    expect(createdMarketIdFor(receipt([marketCreatedLog(91n, SAFE, 0), marketCreatedLog(92n, SAFE, 1)]), SAFE)).toBeNull();
    expect(createdMarketIdFor(receipt([marketCreatedLog(90n, OTHER_SAFE, 0)]), SAFE)).toBeNull();
  });
});

describe('rule 1: every price pool the page builds parses in the resolver', () => {
  const NOW = 1_800_000_000;
  // cf-worker/src/index.ts parsePriceFeedOracleRef (line 660) and the sponsor's copy (aa-call-allowlist.ts:781).
  const RESOLVER_STRIKE = /^\+?(\d+\.\d+|\d+|\.\d+)$/;
  // Strings the target input lets through (it strips everything but digits and '.'), odd ones and ordinary ones.
  const cases: [kind: 'forex' | 'commodities' | 'stocks', symbol: string, typed: string][] = [
    ['forex', 'EURUSD', '0.0000001'],
    ['stocks', 'AAPL', '1000000000000000000000'],
    ['forex', 'EURUSD', '1.095'],
    ['forex', 'EURUSD', '0.000001'],
    ['commodities', 'XAUUSD', '2400'],
    ['stocks', 'AAPL', '999999999999'],
  ];
  for (const [kind, symbol, typed] of cases) {
    it(`${kind} ${symbol} target "${typed}": if built, it must settle`, () => {
      const r = buildPool({ kind, symbol, direction: 'above', strike: Number(typed), durationSec: 3600 }, NOW);
      // Refusing the target with a plain reason also meets the rule; building a pool the resolver cannot read does not
      // (a wallet account's createMarket has no reference check, so the seed would sit until forceRefund).
      if (!r.ok) return;
      const [sym, op, strike] = r.pool.oracleRef.split(':');
      expect({ sym, op, strikeOk: RESOLVER_STRIKE.test(strike), value: Number(strike) }).toEqual({ sym: symbol, op: 'gt', strikeOk: true, value: Number(typed) });
    });
  }

  it('builds the ordinary targets rather than refusing them', () => {
    expect(buildPool({ kind: 'forex', symbol: 'EURUSD', direction: 'above', strike: 1.095, durationSec: 3600 }, NOW).ok).toBe(true);
    expect(buildPool({ kind: 'forex', symbol: 'EURUSD', direction: 'above', strike: 0.000001, durationSec: 3600 }, NOW).ok).toBe(true);
    expect(buildPool({ kind: 'forex', symbol: 'EURUSD', direction: 'above', strike: 0.0000001, durationSec: 3600 }, NOW)).toEqual({ ok: false, reason: 'This target is too small or too large for a pool to settle.' });
  });
});
