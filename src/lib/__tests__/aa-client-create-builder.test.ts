// ----------------------------------------------------------------------------
// src/lib/__tests__/aa-client-create-builder.test.ts
//
// Cross-module pin for `buildCreateMarketSponsorRequest`. Closes the
// wrapper-hotfix learning at the create-market layer:
//
//   1. Body shape pinned literally (kind, chainId, target, value).
//   2. Inner selector pinned via the literal 0xda6a7338 string —
//      independent of any local ABI fragment.
//   3. Each createMarket arg slot decoded back and asserted equal to
//      the input. Fixture deliberately uses `bettingCloseTime !==
//      closeTime` so any swap of the adjacent uint64 slots is
//      detected (round-5 MAJOR).
//   4. The validator (production server-side) accepts bytes produced
//      by the builder (production browser-side). End-to-end round-
//      trip across the client/server boundary.
//
// No fetch mocks, no Magic mocks. Pure-input pure-output. Round-2
// MAJOR 5 closure: `runCreateMarket` is the e2e shell; this test
// targets the pure builder it delegates to.
// ----------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';

import { buildCreateMarketSponsorRequest } from '../aa-client';
import {
  assertCreateMarketCall,
  CREATEMARKET_SELECTOR,
} from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';

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

describe('buildCreateMarketSponsorRequest cross-module pin', () => {
  // Fixture: bettingCloseTime !== closeTime so swapped uint64 slots
  // surface in the per-field assertion. Numeric values chosen so a
  // swap is not a no-op.
  const args = {
    chainId: MONAD_TESTNET_ID,
    makoAddress: MAKO_ADDRESS,
    mType: 0, // CRYPTO
    oracleRef:
      '0xab0000000000000000000000000000000000000000000000000000000000ffaa' as Hex,
    bettingCloseTime: 1_800_000_300n,
    closeTime: 1_800_000_900n, // distinct from bettingCloseTime — swap-detectable
    question: 'BTC > 100k by close?',
  };

  it('produces the expected outer body shape (kind/chainId/target/value)', () => {
    const body = buildCreateMarketSponsorRequest(args);

    expect(body.kind).toBe('create_market');
    expect(body.chainId).toBe(args.chainId);
    expect(body.call.to).toBe(args.makoAddress);
    expect(body.call.value).toBe('0x0');
  });

  it('inner selector pinned by literal 0xda6a7338 (independent of local ABI)', () => {
    const body = buildCreateMarketSponsorRequest(args);
    expect(body.call.data.slice(0, 10)).toBe('0xda6a7338');
    // Cross-check: the constant the validator uses matches.
    expect(body.call.data.slice(0, 10)).toBe(CREATEMARKET_SELECTOR);
  });

  it('decoded args match input at every slot (uint64 swap regression)', () => {
    const body = buildCreateMarketSponsorRequest(args);

    const decoded = decodeFunctionData({
      abi: CREATEMARKET_ABI,
      data: body.call.data,
    });
    expect(decoded.functionName).toBe('createMarket');
    const decodedArgs = decoded.args as readonly [
      number,
      Hex,
      bigint,
      bigint,
      string,
    ];

    expect(decodedArgs[0]).toBe(args.mType);
    expect(decodedArgs[1].toLowerCase()).toBe(args.oracleRef.toLowerCase());
    // The two adjacent uint64s — if a future encoder typo swapped
    // them, the values would be identical-shaped but wrong-position.
    // Distinct fixture values prove this stays correct.
    expect(decodedArgs[2]).toBe(args.bettingCloseTime);
    expect(decodedArgs[3]).toBe(args.closeTime);
    expect(decodedArgs[2]).not.toBe(decodedArgs[3]);
    expect(decodedArgs[4]).toBe(args.question);
  });

  it('validator accepts builder output (e2e client→server round-trip)', () => {
    const body = buildCreateMarketSponsorRequest(args);

    // nowSec chosen 1 hour before closeTime → comfortably inside the
    // duration window, well past MIN+SERVER_BUFFER.
    expect(() =>
      assertCreateMarketCall({
        chainId: body.chainId,
        safeAddress: SAFE,
        call: {
          to: body.call.to,
          value: 0n, // builder emits '0x0'; validator takes bigint
          data: body.call.data,
        },
        nowSec: args.closeTime - 3600n,
      }),
    ).not.toThrow();
  });

  it('builder is pure — same input → same output across calls', () => {
    const a = buildCreateMarketSponsorRequest(args);
    const b = buildCreateMarketSponsorRequest(args);
    expect(a).toEqual(b);
  });
});
