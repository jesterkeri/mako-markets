// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-call-allowlist-create.test.ts
//
// Phase 1H create-market allowlist test matrix. Three describe blocks:
//
//   describe('assertCreateMarketCall', ...)
//     Sponsor-time validator with chain-time `nowSec`. Validates target,
//     value, selector, mType enum, question byte length, and all five
//     timestamp invariants (including the asymmetric server buffer).
//
//   describe('assertSponsoredCallData (extended for create_market)', ...)
//     Send-time, decodes the persisted Safe wrapper. Operation=0, target
//     = MAKO. Dispatches by 4-byte selector: placeBet vs createMarket vs
//     unknown. Send-time CANNOT enforce timestamp invariants (drift-stable
//     shape only — Guard A catches clock drift at hash level).
//
//   describe('selector dispatch regression', ...)
//     Pins that a malformed-placeBet payload still surfaces
//     `bad_placebet_args`, NOT a stray `bad_create_args` or `bad_selector`.
//     Closes plan round-3 MAJOR 3 risk.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { encodeFunctionData, stringToHex, type Address, type Hex } from 'viem';

import {
  assertCreateMarketCall,
  assertSponsoredCallData,
  CREATEMARKET_SELECTOR,
  NotAllowedError,
  PLACEBET_SELECTOR,
} from '../aa-call-allowlist';
import {
  CREATE_MARKET_MIN_SERVER_BUFFER_SEC,
  MAKO_ADMIN_SAFE_ADDRESS,
  MAKO_V4_MAX_DURATION_SEC,
  MAKO_V4_MIN_DURATION_SEC,
  MIN_CREATOR_SEED_USDC_BASE,
} from '../aa-constants';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';

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

const ORACLE_REF: Hex =
  '0x4254433a67743a313030303030000000000000000000000000000000000000ff';

/// Encode a `SYMBOL:op:STRIKE` ASCII string into a bytes32 (right-padded
/// with zeros). Used by the #180 price-feed gate tests; the existing
/// FOOTBALL / CRYPTO / BASKETBALL coverage keeps using the BTC oracleRef
/// constant above.
function priceFeedOracleRef(symbol: string, op: 'gt' | 'lt', strike: string): Hex {
  return stringToHex(`${symbol}:${op}:${strike}`, { size: 32 });
}

/// Class-appropriate oracleRef per mType. Tests that loop over multiple
/// mTypes use this so the price-feed gate (#180) gets a valid symbol
/// for mType 3/4/5; non-price-feed mTypes (0/1/2/6) keep the BTC ref
/// since they don't go through the price-feed allowlist.
function oracleRefForMType(mType: number): Hex {
  if (mType === 3) return priceFeedOracleRef('EURUSD', 'gt', '1.0850');
  if (mType === 4) return priceFeedOracleRef('XAUUSD', 'gt', '2400');
  if (mType === 5) return priceFeedOracleRef('AAPL', 'gt', '170');
  return ORACLE_REF;
}

function encodeCreateMarket(args: {
  mType: number;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
  /// v4 redeploy: optional in the test helper for terse fixtures, but the
  /// underlying ABI requires it. Default to the minimum valid value
  /// (1 USDC seed on YES) so existing tests keep passing the contract
  /// invariant; tests that exercise seed-specific paths override.
  creatorSeed?: bigint;
  creatorYes?: boolean;
}): Hex {
  return encodeFunctionData({
    abi: CREATEMARKET_ABI,
    functionName: 'createMarket',
    args: [
      args.mType,
      args.oracleRef,
      args.bettingCloseTime,
      args.closeTime,
      args.question,
      args.creatorSeed ?? 1_000_000n,
      args.creatorYes ?? true,
    ],
  });
}

function wrapOpZero(args: { to: Address; value: bigint; data: Hex }): Hex {
  return encodeFunctionData({
    abi: SAFE_WRAPPER_ABI,
    functionName: 'executeUserOp',
    args: [args.to, args.value, args.data, 0],
  });
}

const NOW_SEC = 1_800_000_000n;

describe('assertCreateMarketCall', () => {
  it('accepts a valid 1-hour crypto market', async () => {
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0, // FOOTBALL — validator only enforces enum range, not semantics
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n, // 30 min
            closeTime: NOW_SEC + 3600n, // 1 hour
            question: 'BTC > 100k by close?',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts every valid non-MAKO mType ∈ {0..5} (FOOTBALL/CRYPTO/BASKETBALL/FOREX/COMMODITIES/STOCKS)', async () => {
    // MAKO (mType=6) is admin-gated by SAFE === MAKO_ADMIN_SAFE_ADDRESS and
    // requires creatorSeed=0n. It gets its own dedicated tests below for
    // the admin + zero-seed + blocklist-bypass branches.
    for (const mType of [0, 1, 2, 3, 4, 5]) {
      await expect(
        assertCreateMarketCall({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: {
            to: MAKO_ADDRESS,
            value: 0n,
            data: encodeCreateMarket({
              mType,
              // mTypes 3/4/5 now run through the #180 price-feed gate;
              // use a class-appropriate symbol per mType. The other
              // mTypes keep the BTC oracleRef constant from above.
              oracleRef: oracleRefForMType(mType),
              bettingCloseTime: NOW_SEC + 1800n,
              closeTime: NOW_SEC + 3600n,
              question: 'q',
            }),
          },
          nowSec: NOW_SEC,
          readBlocked: async () => false,
          readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('rejects mType = 7 (out of range) with bad_create_mtype_out_of_range', async () => {
    // mType=3..6 are now valid (FOREX/COMMODITIES/STOCKS/MAKO). mType=7+ is
    // outside the contract enum and must reject with the dedicated reason.
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 7,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_mtype_out_of_range',
      );
    }
  });

  // ── v4 redeploy (slice 4c-1) branch regressions ────────────────────────
  // The validator added five distinct rejection paths and one bypass-by-
  // design path. Each is pinned below so a future refactor that drops a
  // gate is caught in CI rather than at a real sponsor-route call.

  it('rejects non-MAKO seed below MIN_CREATOR_SEED with bad_create_seed_too_small', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 1, // CRYPTO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
            creatorSeed: MIN_CREATOR_SEED_USDC_BASE - 1n,
            creatorYes: true,
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_seed_too_small');
    }
  });

  it('rejects MAKO with nonzero seed via bad_create_mako_nonzero_seed', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: MAKO_ADMIN_SAFE_ADDRESS as Address,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 6, // MAKO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
            creatorSeed: 1n, // any nonzero is invalid for MAKO
            creatorYes: true,
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_mako_nonzero_seed',
      );
    }
  });

  it('rejects MAKO from non-admin Safe with bad_create_mako_non_admin', async () => {
    // SAFE is the test's generic non-admin Safe; MAKO_ADMIN_SAFE_ADDRESS
    // defaults to the zero address under test env. The gate must reject.
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 6, // MAKO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
            creatorSeed: 0n, // shape-valid for MAKO
            creatorYes: true,
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_mako_non_admin');
    }
  });

  it('rejects non-MAKO blocked Safe with bad_create_blocked_wallet', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 1, // CRYPTO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => true, // chain says blocked
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_blocked_wallet');
    }
  });

  it('MAKO path skips readBlocked (bypass-by-design, codex r3 m-1)', async () => {
    // Pin the bypass: MAKO admin can create even if setBlocked flagged
    // the admin Safe. readBlocked MUST NOT be invoked on the MAKO path.
    let readBlockedInvoked = false;
    await assertCreateMarketCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: MAKO_ADMIN_SAFE_ADDRESS as Address,
      call: {
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 6, // MAKO
          oracleRef: ORACLE_REF,
          bettingCloseTime: NOW_SEC + 1800n,
          closeTime: NOW_SEC + 3600n,
          question: 'q',
          creatorSeed: 0n,
          creatorYes: true,
        }),
      },
      nowSec: NOW_SEC,
      readBlocked: async () => {
        readBlockedInvoked = true;
        return true; // even "blocked" must not cause rejection on MAKO
      },
      readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
    });
    expect(readBlockedInvoked).toBe(false);
  });

  // ── Daily-cap mirror (slice 4f) ──────────────────────────────────────
  // Sponsor-time `creatorCreatesToday` read is the same defense-in-depth
  // shape as `readBlocked`: reject ops we *know* will revert at the
  // contract so the Magic flow doesn't burn sponsor budget. Three pins:
  //
  //   1. Non-MAKO with count >= 10 → bad_create_daily_cap_exceeded
  //   2. Non-MAKO with count < 10 → accepted
  //   3. MAKO bypasses the read entirely (contract-exempt from the cap)

  it('rejects non-MAKO when creatorCreatesToday count >= 10 (cap mirror)', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 1, // CRYPTO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 10n, remaining: 0n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_daily_cap_exceeded',
      );
    }
  });

  it('accepts non-MAKO at count = 9 (one slot remaining)', async () => {
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 1, // CRYPTO
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 9n, remaining: 1n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('MAKO path skips readCreatorCreatesToday (contract-exempt from cap)', async () => {
    // Mirror of the readBlocked bypass test: MAKO must not invoke the
    // cap read either. The contract's daily cap lives in the non-MAKO
    // branch only, so sponsor-time mirror must match.
    let capReadInvoked = false;
    await assertCreateMarketCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: MAKO_ADMIN_SAFE_ADDRESS as Address,
      call: {
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeCreateMarket({
          mType: 6, // MAKO
          oracleRef: ORACLE_REF,
          bettingCloseTime: NOW_SEC + 1800n,
          closeTime: NOW_SEC + 3600n,
          question: 'q',
          creatorSeed: 0n,
          creatorYes: true,
        }),
      },
      nowSec: NOW_SEC,
      readBlocked: async () => false,
      readCreatorCreatesToday: async () => {
        capReadInvoked = true;
        return { count: 99n, remaining: 0n }; // even "way over" cap must not block MAKO
      },
    });
    expect(capReadInvoked).toBe(false);
  });

  it('rejects unsupported chain with bad_create_args', async () => {
    try {
      await assertCreateMarketCall({
        chainId: 1, // mainnet
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
      expect((e as NotAllowedError).detail).toBe('wrong_chain');
    }
  });

  it('rejects wrong target (USDC instead of MAKO) with bad_create_args', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: USDC_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
      expect((e as NotAllowedError).detail).toBe('wrong_target');
    }
  });

  it('rejects non-zero outer value with bad_value', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 1n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects empty question with bad_create_question', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: '',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('accepts question at exactly 200 bytes', async () => {
    const q200 = 'a'.repeat(200);
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: q200,
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects question at 201 bytes with bad_create_question', async () => {
    const q201 = 'a'.repeat(201);
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: q201,
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('rejects multi-byte UTF-8 question that exceeds 200 BYTES (not chars)', async () => {
    // 67 emoji glyphs × 4 bytes/glyph = 268 bytes; under 200 chars.
    const emojiHeavy = '🚀'.repeat(67);
    expect(emojiHeavy.length).toBeLessThan(200); // glyph count
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: emojiHeavy,
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('rejects bettingCloseTime > closeTime with bad_create_timestamps', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 7200n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
      expect((e as NotAllowedError).detail).toBe('betting_after_close');
    }
  });

  it('rejects closeTime in the past', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC - 100n,
            closeTime: NOW_SEC - 50n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
    }
  });

  it('rejects duration just below MIN+SERVER_BUFFER (329s) with duration_too_short', async () => {
    const tooShort = MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC - 1n;
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 100n,
            closeTime: NOW_SEC + tooShort,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
      expect((e as NotAllowedError).detail).toBe('duration_too_short');
    }
  });

  it('accepts duration at exactly MIN+SERVER_BUFFER (330s)', async () => {
    const exact = MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC;
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 100n,
            closeTime: NOW_SEC + exact,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts duration at exactly MAX_DURATION (7 days)', async () => {
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1000n,
            closeTime: NOW_SEC + MAKO_V4_MAX_DURATION_SEC,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects duration > MAX_DURATION with duration_too_long (no max-side slack)', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1000n,
            closeTime: NOW_SEC + MAKO_V4_MAX_DURATION_SEC + 1n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
      expect((e as NotAllowedError).detail).toBe('duration_too_long');
    }
  });

  // Asymmetric-buffer pin: simulates "client submitted closeTime = clientNow + 360"
  // (UI's TX_LANDING_BUFFER_SEC=60 + MIN_DURATION=300) and the server reads chain
  // block at clientNow + 5 (typical RPC delta). 360 - 5 = 355 >= 330 → accept.
  // Same submission against clientNow + 35 → 360 - 35 = 325 < 330 → reject.
  // Round-3 MAJOR 1 regression guard.
  it('asymmetric buffer: accepts UI 5-min preset under typical 5s sponsor-delta', async () => {
    const clientNow = NOW_SEC;
    const closeTime = clientNow + 360n; // UI's clientNow + 300 + 60
    const serverNow = clientNow + 5n;
    await expect(
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: clientNow + 100n,
            closeTime,
            question: 'q',
          }),
        },
        nowSec: serverNow,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      }),
    ).resolves.toBeUndefined();
  });

  it('asymmetric buffer: rejects UI 5-min preset under pathological 35s sponsor-delta', async () => {
    const clientNow = NOW_SEC;
    const closeTime = clientNow + 360n;
    const serverNow = clientNow + 35n; // 35s of network/RPC delay
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: clientNow + 100n,
            closeTime,
            question: 'q',
          }),
        },
        nowSec: serverNow,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
    }
  });

  it('rejects malformed (non-createMarket) calldata with bad_create_args/decode_failed', async () => {
    try {
      await assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: '0xdeadbeef' as Hex,
        },
        nowSec: NOW_SEC,

        readBlocked: async () => false,
        readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
    }
  });
});

describe('assertSponsoredCallData (extended for create_market)', () => {
  function validInner(): Hex {
    return encodeCreateMarket({
      mType: 0,
      oracleRef: ORACLE_REF,
      bettingCloseTime: NOW_SEC + 1800n,
      closeTime: NOW_SEC + 3600n,
      question: 'q',
    });
  }

  it('accepts a valid op=0 createMarket wrapper', async () => {
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: validInner(),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts createMarket without rechecking clock (drift-tolerant)', async () => {
    // Inner timestamps reference NOW_SEC, but send-time validator does
    // NOT take nowSec — clock drift between sponsor and send is caught
    // by Guard A (SafeOp hash recomputation), not by re-validating
    // values here. This test pins that policy: a row that was valid
    // at sponsor time stays valid at send time even if "now" advances.
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            // betting/close are in the past relative to a "now" we
            // don't pass in. Validator does not care.
            bettingCloseTime: 1n,
            closeTime: 2n,
            question: 'q',
          }),
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects bettingCloseTime > closeTime at send-time (immutable shape)', async () => {
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 7200n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
    }
  });

  it('rejects out-of-range mType at send-time with bad_create_mtype_out_of_range', async () => {
    // mType=0..6 are all valid post v4 redeploy. mType=7+ is out of the
    // contract enum range and must be rejected at the send-time shape pass.
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 7,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe(
        'bad_create_mtype_out_of_range',
      );
    }
  });

  it('rejects oversize question at send-time', async () => {
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'a'.repeat(201),
          }),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });
});

describe('selector dispatch regression (round-3 MAJOR 3)', () => {
  it('selector-only placeBet calldata still surfaces bad_placebet_args, not bad_create_args', async () => {
    // 4-byte selector with no args appended. Send-side dispatch routes
    // by selector, so this MUST land in decodeAndAssertPlaceBet (which
    // surfaces bad_placebet_args on decode failure), not in the
    // createMarket validator.
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: PLACEBET_SELECTOR as Hex,
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_placebet_args');
    }
  });

  it('valid placeBet still routes to placeBet validator', async () => {
    const placeBetData = encodeFunctionData({
      abi: PLACEBET_ABI,
      functionName: 'placeBet',
      args: [42n, true, 1_000_000n],
    });
    await expect(
      assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: placeBetData,
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it('unknown selector against MAKO surfaces bad_selector', async () => {
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: '0xdeadbeef' as Hex,
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_selector');
    }
  });

  it('selectors are exported as the literal constants asserted by selector test', async () => {
    // Belt-and-suspenders: this file imports them; assert the selector
    // strings are the well-known 4-byte values. Round-trips with the
    // selector-pinning test file.
    expect(PLACEBET_SELECTOR).toBe('0x1a38cac6');
    expect(CREATEMARKET_SELECTOR).toBe('0xd1aa0ea8');
  });
});
