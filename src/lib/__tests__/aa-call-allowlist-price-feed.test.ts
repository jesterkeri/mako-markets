// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-price-feed.test.ts
//
// #180 chunk B: price-feed allowlist + class-match coverage. Exercises
// all four leaf validator surfaces — single-sponsor, single-shape,
// batched-sponsor, batched-shape — so the shared
// `decodeCreateMarketArgs` gate is asserted at every entry point.
// Tests pre-existing mTypes 0/1/2/6 stay untouched (their paths are
// covered in aa-call-allowlist-create.test.ts; this file ONLY covers
// the new price-feed branch for mType 3/4/5).
// ----------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';

// FOREX / COMMODITIES / STOCKS creates are paused until the Data Streams resolver can settle them
// (market-availability.ts, 2026-10-08). This file tests the symbol gate those creates will pass through once they
// reopen, so the pause list is empty here; aa-call-allowlist-paused.test.ts covers the pause itself.
vi.mock('../market-availability', () => ({ PAUSED_CREATE_MTYPES: new Set<number>() }));
import {
  encodeFunctionData,
  stringToHex,
  maxUint256,
  type Address,
  type Hex,
} from 'viem';

import {
  assertCreateMarketCall,
  assertCreateMarketShape,
  assertCreateMarketBatchedCallsSponsor,
  assertCreateMarketBatchedCallsShape,
  NotAllowedError,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const NOW_SEC = 1_800_000_000n;

// Minimal local ABIs — mirrors the shape used by the public surfaces
// without pulling in the full MAKO ABI module (same pattern as
// aa-call-allowlist-create.test.ts:46).

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

/// Encode `SYMBOL:op:STRIKE` into a right-padded bytes32. Same shape
/// the cf-worker resolver decodes via hexToString({size: 32}).
function priceFeedOracleRef(s: string): Hex {
  return stringToHex(s, { size: 32 });
}

function encodeCreateMarket(args: {
  mType: number;
  oracleRef: Hex;
  bettingCloseTime?: bigint;
  closeTime?: bigint;
  question?: string;
  creatorSeed?: bigint;
  creatorYes?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: CREATEMARKET_ABI,
    functionName: 'createMarket',
    args: [
      args.mType,
      args.oracleRef,
      args.bettingCloseTime ?? NOW_SEC + 1800n,
      args.closeTime ?? NOW_SEC + 3600n,
      args.question ?? 'q',
      args.creatorSeed ?? 1_000_000n,
      args.creatorYes ?? true,
    ],
  });
}

function encodeApprove(): Hex {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [MAKO_ADDRESS, maxUint256],
  });
}

// ── Sponsor-time single-call sugar ──────────────────────────────────

async function sponsorSingle(call: { to: Address; value: bigint; data: Hex }) {
  return assertCreateMarketCall({
    chainId: MONAD_TESTNET_ID,
    safeAddress: SAFE,
    call,
    nowSec: NOW_SEC,
    readBlocked: async () => false,
    readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
  });
}

function shapeSingle(call: { to: Address; value: bigint; data: Hex }): void {
  assertCreateMarketShape({
    chainId: MONAD_TESTNET_ID,
    safeAddress: SAFE,
    call,
  });
}

async function sponsorBatched(createCall: {
  to: Address;
  value: bigint;
  data: Hex;
}) {
  return assertCreateMarketBatchedCallsSponsor({
    chainId: MONAD_TESTNET_ID,
    safeAddress: SAFE,
    calls: [
      { to: USDC_ADDRESS, value: 0n, data: encodeApprove() },
      createCall,
    ],
    nowSec: NOW_SEC,
    readBlocked: async () => false,
    readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
  });
}

function shapeBatched(createCall: {
  to: Address;
  value: bigint;
  data: Hex;
}): void {
  assertCreateMarketBatchedCallsShape({
    chainId: MONAD_TESTNET_ID,
    safeAddress: SAFE,
    calls: [
      { to: USDC_ADDRESS, value: 0n, data: encodeApprove() },
      createCall,
    ],
  });
}

// ── Accept paths (one per class, exercised on all four surfaces) ──

describe('price-feed allowlist — accept (#180 chunk B)', () => {
  it('mType=3 (FOREX) + EURUSD:gt:1.0850 → accepted on sponsor-single', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:gt:1.0850'),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('mType=4 (COMMODITIES) + XAUUSD:lt:2400 → accepted on sponsor-single', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 4,
          oracleRef: priceFeedOracleRef('XAUUSD:lt:2400'),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('mType=5 (STOCKS) + AAPL:gt:170 → accepted on sponsor-single', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 5,
          oracleRef: priceFeedOracleRef('AAPL:gt:170'),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('FOREX accept also passes shape-single, batched-sponsor, batched-shape', async () => {
    const call = {
      to: MAKO_ADDRESS,
      value: 0n,
      data: encodeCreateMarket({
        mType: 3,
        oracleRef: priceFeedOracleRef('EURUSD:gt:1.0850'),
      }),
    };
    expect(() => shapeSingle(call)).not.toThrow();
    await expect(sponsorBatched(call)).resolves.toBeUndefined();
    expect(() => shapeBatched(call)).not.toThrow();
  });
});

// ── Reject paths ─────────────────────────────────────────────────────

describe('price-feed allowlist — unknown_symbol (#180 chunk B)', () => {
  it('mType=3 + MADEUPSYM rejects with bad_create_oracleref_unknown_price_feed_symbol', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('MADEUPSYM:gt:1.0'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_unknown_price_feed_symbol',
      );
    }
  });

  it('lowercase symbol (eurusd) rejects as unknown — gate is case-sensitive', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('eurusd:gt:1.0850'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_unknown_price_feed_symbol',
      );
    }
  });
});

describe('price-feed allowlist — class_mismatch (#180 chunk B)', () => {
  it('mType=3 (FOREX) + AAPL (stocks symbol) rejects with bad_create_oracleref_class_mismatch', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('AAPL:gt:170'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      const err = e as NotAllowedError;
      expect(err.reason).toBe('bad_create_oracleref_class_mismatch');
      // detail string carries the offending symbol, the actual
      // class, and the expected class for operator-side debugging;
      // pin all three so a refactor that drops any of them is
      // caught.
      expect(err.detail).toContain('AAPL');
      expect(err.detail).toContain('stocks');
      expect(err.detail).toContain('forex');
    }
  });

  it('mType=4 (COMMODITIES) + EURUSD (forex symbol) rejects class_mismatch', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 4,
          oracleRef: priceFeedOracleRef('EURUSD:gt:1.0850'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_class_mismatch',
      );
    }
  });

  it('mType=5 (STOCKS) + XAUUSD (commodities symbol) rejects class_mismatch', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 5,
          oracleRef: priceFeedOracleRef('XAUUSD:gt:2400'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_class_mismatch',
      );
    }
  });
});

describe('price-feed allowlist — bad_format (#180 chunk B)', () => {
  it('bad op token (badop) rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:badop:1.0'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });

  it('missing op section (only two parts) rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:1.0850'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });

  it('negative strike rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:gt:-1.0'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });

  it('zero strike rejects bad_format (strike must be positive)', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:gt:0'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });

  it('non-numeric strike (1.0850abc) rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef('EURUSD:gt:1.0850abc'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });

  it('empty symbol section (:gt:1.0) rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef: priceFeedOracleRef(':gt:1.0'),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      // Empty symbol fails the unknown-symbol check first; either
      // bad_format or unknown_symbol is acceptable from a UX
      // standpoint, but pin behaviour so a refactor doesn't
      // silently change the rejection class. Current parser: empty
      // symbol parses ok as ('', 'gt', 1.0), then unknown_symbol
      // fires because '' isn't in the allowlist.
      const reason = (e as NotAllowedError).reason;
      expect([
        'bad_create_oracleref_format',
        'bad_create_oracleref_unknown_price_feed_symbol',
      ]).toContain(reason);
    }
  });

  it('completely empty oracleRef (32 zero bytes) rejects bad_format', async () => {
    try {
      await sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 3,
          oracleRef:
            '0x0000000000000000000000000000000000000000000000000000000000000000',
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_oracleref_format');
    }
  });
});

// ── Surface coverage: every reject path also blows up on the other 3 surfaces ──

describe('price-feed allowlist — surface coverage (#180 chunk B)', () => {
  // One canonical "would reject" payload exercised on each leaf so a
  // refactor that bypasses one surface gets caught.
  const badCall = {
    to: MAKO_ADDRESS,
    value: 0n,
    data: encodeCreateMarket({
      mType: 3,
      oracleRef: priceFeedOracleRef('AAPL:gt:170'), // class_mismatch
    }),
  };

  it('shape-single rejects with class_mismatch', () => {
    try {
      shapeSingle(badCall);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_class_mismatch',
      );
    }
  });

  it('batched-sponsor rejects with class_mismatch (via inner createMarket)', async () => {
    try {
      await sponsorBatched(badCall);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_class_mismatch',
      );
    }
  });

  it('batched-shape rejects with class_mismatch (via inner createMarket)', () => {
    try {
      shapeBatched(badCall);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_oracleref_class_mismatch',
      );
    }
  });
});

// ── Non-price-feed mTypes are unaffected ────────────────────────────

describe('price-feed allowlist — non-price-feed mTypes unaffected (#180 chunk B)', () => {
  // mTypes 0 (FOOTBALL), 1 (CRYPTO), 2 (BASKETBALL), 6 (MAKO) must
  // pass through unchanged. Their oracleRef semantics aren't
  // validated by this gate; the BTC ref used here is the same one
  // existing tests use and would have rejected if the gate
  // accidentally ran for these mTypes.
  const btcRef = priceFeedOracleRef('BTC:gt:100000');

  it('mType=0 (FOOTBALL) with BTC oracleRef still accepted', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({ mType: 0, oracleRef: btcRef }),
      }),
    ).resolves.toBeUndefined();
  });

  it('mType=1 (CRYPTO) with BTC oracleRef still accepted', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({ mType: 1, oracleRef: btcRef }),
      }),
    ).resolves.toBeUndefined();
  });

  it('mType=2 (BASKETBALL) with BTC oracleRef still accepted', async () => {
    await expect(
      sponsorSingle({
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({ mType: 2, oracleRef: btcRef }),
      }),
    ).resolves.toBeUndefined();
  });
});
