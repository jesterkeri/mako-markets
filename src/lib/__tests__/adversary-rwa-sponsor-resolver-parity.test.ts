// Adversary pass on feat/ds-rwa 67a1cbe (forex / metals / stocks on Chainlink Data Streams v8).
//
// Spec: every forex / commodities / stocks pool the gas sponsor accepts must be settleable by the resolver (same class,
// pinned feed, strike parseable). The sponsor's create check (aa-call-allowlist.ts parsePriceFeedOracleRef) decodes the
// bytes32 as UTF-8 and String.trim()s it, so it accepts refs carrying a tab, a newline or a no-break space at the edges.
// The resolver's new parser (cf-worker/src/rwa-decision.ts parseRwaRef) refuses any byte below 0x20 or above 0x7e, so
// such a pool is `parse_fail` for ever: never evaluated, never settled. rwa-decision.ts is pure (viem types + JSON
// only), so both sides run here on the same bytes.
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, stringToHex, type Address, type Hex } from 'viem';

import { rwaFeedFor, parseRwaRef } from '../../../cf-worker/src/rwa-decision';
import { assertCreateMarketCall, NotAllowedError } from '../aa-call-allowlist';
import { MAKO_ADDRESS } from '../contract';
import { MONAD_TESTNET_ID } from '../chain';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const NOW_SEC = 1_800_000_000n;
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

async function sponsorVerdict(mType: number, oracleRef: Hex): Promise<string> {
  try {
    await assertCreateMarketCall({
      chainId: MONAD_TESTNET_ID,
      safeAddress: SAFE,
      call: {
        to: MAKO_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: CREATEMARKET_ABI,
          functionName: 'createMarket',
          args: [mType, oracleRef, NOW_SEC + 1800n, NOW_SEC + 3600n, 'q', 1_000_000n, true],
        }),
      },
      nowSec: NOW_SEC,
      readBlocked: async () => false,
      readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }),
    });
    return 'ok';
  } catch (e) {
    return (e as NotAllowedError).reason;
  }
}

describe('a pool the sponsor accepts is one the Data Streams resolver can settle', () => {
  it.each([
    ['trailing tab', 3, 'EURUSD:gt:1.1\t'],
    ['trailing newline', 3, 'EURUSD:gt:1.1\n'],
    ['leading tab', 4, '\tXAUUSD:gt:2400'],
    ['tab inside a part', 5, 'AAPL\t:gt:170'],
    ['no-break space (UTF-8 c2 a0)', 3, 'EURUSD:lt:1.2 '],
  ])('%s', async (_label, mType, text) => {
    const ref = stringToHex(text, { size: 32 });
    const sponsor = await sponsorVerdict(mType, ref);
    const fed = rwaFeedFor(mType, parseRwaRef(ref));
    // Accepted at create implies eligible at resolve. Either fix passes: the sponsor refusing the ref, or the resolver
    // reading it.
    const verdict = { sponsor, resolverEligible: fed.ok, reason: fed.ok ? null : fed.reason };
    if (sponsor === 'ok') expect(verdict).toEqual({ sponsor: 'ok', resolverEligible: true, reason: null });
  });
});
