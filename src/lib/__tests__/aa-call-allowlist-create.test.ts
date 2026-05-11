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
import { encodeFunctionData, type Address, type Hex } from 'viem';

import {
  assertCreateMarketCall,
  assertSponsoredCallData,
  CREATEMARKET_SELECTOR,
  NotAllowedError,
  PLACEBET_SELECTOR,
} from '../aa-call-allowlist';
import {
  CREATE_MARKET_MIN_SERVER_BUFFER_SEC,
  MAKO_V4_MAX_DURATION_SEC,
  MAKO_V4_MIN_DURATION_SEC,
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

function encodeCreateMarket(args: {
  mType: number;
  oracleRef: Hex;
  bettingCloseTime: bigint;
  closeTime: bigint;
  question: string;
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
  it('accepts a valid 1-hour crypto market', () => {
    expect(() =>
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 0, // FOOTBALL — validator only enforces 0|1|2 enum, not semantics
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n, // 30 min
            closeTime: NOW_SEC + 3600n, // 1 hour
            question: 'BTC > 100k by close?',
          }),
        },
        nowSec: NOW_SEC,
      }),
    ).not.toThrow();
  });

  it('accepts every valid mType ∈ {0=FOOTBALL, 1=CRYPTO, 2=BASKETBALL}', () => {
    for (const mType of [0, 1, 2]) {
      expect(() =>
        assertCreateMarketCall({
          chainId: MONAD_TESTNET_ID,
          safeAddress: SAFE,
          call: {
            to: MAKO_ADDRESS,
            value: 0n,
            data: encodeCreateMarket({
              mType,
              oracleRef: ORACLE_REF,
              bettingCloseTime: NOW_SEC + 1800n,
              closeTime: NOW_SEC + 3600n,
              question: 'q',
            }),
          },
          nowSec: NOW_SEC,
        }),
      ).not.toThrow();
    }
  });

  it('rejects mType = 3 with bad_create_args', () => {
    try {
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 3,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
      expect((e as NotAllowedError).detail).toBe('bad_mtype_enum');
    }
  });

  it('rejects unsupported chain with bad_create_args', () => {
    try {
      assertCreateMarketCall({
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
      expect((e as NotAllowedError).detail).toBe('wrong_chain');
    }
  });

  it('rejects wrong target (USDC instead of MAKO) with bad_create_args', () => {
    try {
      assertCreateMarketCall({
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
      expect((e as NotAllowedError).detail).toBe('wrong_target');
    }
  });

  it('rejects non-zero outer value with bad_value', () => {
    try {
      assertCreateMarketCall({
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_value');
    }
  });

  it('rejects empty question with bad_create_question', () => {
    try {
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
            question: '',
          }),
        },
        nowSec: NOW_SEC,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('accepts question at exactly 200 bytes', () => {
    const q200 = 'a'.repeat(200);
    expect(() =>
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
      }),
    ).not.toThrow();
  });

  it('rejects question at 201 bytes with bad_create_question', () => {
    const q201 = 'a'.repeat(201);
    try {
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
            question: q201,
          }),
        },
        nowSec: NOW_SEC,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('rejects multi-byte UTF-8 question that exceeds 200 BYTES (not chars)', () => {
    // 67 emoji glyphs × 4 bytes/glyph = 268 bytes; under 200 chars.
    const emojiHeavy = '🚀'.repeat(67);
    expect(emojiHeavy.length).toBeLessThan(200); // glyph count
    try {
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
            question: emojiHeavy,
          }),
        },
        nowSec: NOW_SEC,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_question');
    }
  });

  it('rejects bettingCloseTime > closeTime with bad_create_timestamps', () => {
    try {
      assertCreateMarketCall({
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
      expect((e as NotAllowedError).detail).toBe('betting_after_close');
    }
  });

  it('rejects closeTime in the past', () => {
    try {
      assertCreateMarketCall({
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
    }
  });

  it('rejects duration just below MIN+SERVER_BUFFER (329s) with duration_too_short', () => {
    const tooShort = MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC - 1n;
    try {
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
            closeTime: NOW_SEC + tooShort,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
      expect((e as NotAllowedError).detail).toBe('duration_too_short');
    }
  });

  it('accepts duration at exactly MIN+SERVER_BUFFER (330s)', () => {
    const exact = MAKO_V4_MIN_DURATION_SEC + CREATE_MARKET_MIN_SERVER_BUFFER_SEC;
    expect(() =>
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
      }),
    ).not.toThrow();
  });

  it('accepts duration at exactly MAX_DURATION (7 days)', () => {
    expect(() =>
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
      }),
    ).not.toThrow();
  });

  it('rejects duration > MAX_DURATION with duration_too_long (no max-side slack)', () => {
    try {
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
            closeTime: NOW_SEC + MAKO_V4_MAX_DURATION_SEC + 1n,
            question: 'q',
          }),
        },
        nowSec: NOW_SEC,
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
  it('asymmetric buffer: accepts UI 5-min preset under typical 5s sponsor-delta', () => {
    const clientNow = NOW_SEC;
    const closeTime = clientNow + 360n; // UI's clientNow + 300 + 60
    const serverNow = clientNow + 5n;
    expect(() =>
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
      }),
    ).not.toThrow();
  });

  it('asymmetric buffer: rejects UI 5-min preset under pathological 35s sponsor-delta', () => {
    const clientNow = NOW_SEC;
    const closeTime = clientNow + 360n;
    const serverNow = clientNow + 35n; // 35s of network/RPC delay
    try {
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
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_timestamps');
    }
  });

  it('rejects malformed (non-createMarket) calldata with bad_create_args/decode_failed', () => {
    try {
      assertCreateMarketCall({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        call: {
          to: MAKO_ADDRESS,
          value: 0n,
          data: '0xdeadbeef' as Hex,
        },
        nowSec: NOW_SEC,
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

  it('rejects bad mType at send-time', async () => {
    try {
      await assertSponsoredCallData({
        chainId: MONAD_TESTNET_ID,
        safeAddress: SAFE,
        callData: wrapOpZero({
          to: MAKO_ADDRESS,
          value: 0n,
          data: encodeCreateMarket({
            mType: 5,
            oracleRef: ORACLE_REF,
            bettingCloseTime: NOW_SEC + 1800n,
            closeTime: NOW_SEC + 3600n,
            question: 'q',
          }),
        }),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as NotAllowedError).reason).toBe('bad_create_args');
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
    expect(CREATEMARKET_SELECTOR).toBe('0xda6a7338');
  });
});
