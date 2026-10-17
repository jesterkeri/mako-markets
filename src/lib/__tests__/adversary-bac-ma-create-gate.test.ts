// Adversary pass on fix/pause-bac-ma (d8ff002). Owner spec 2026-10-16: no new BAC or MA pool by any path the app
// controls, and the pool page must not claim one settles automatically; every other symbol behaves as before.
// Pins the sponsor's create gate (single sponsor-time, send-time shape, batched sponsor and shape) and the pool page
// parser on the same refs, including case and whitespace variants, against what the live resolver reads
// (cf-worker/src/rwa-decision.ts parseRwaRef + rwaFeedFor).
import { encodeFunctionData, erc20Abi, maxUint256, stringToHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { parseRwaRef, rwaFeedFor } from '../../../cf-worker/src/rwa-decision';
import {
  assertCreateMarketBatchedCallsShape,
  assertCreateMarketBatchedCallsSponsor,
  assertCreateMarketCall,
  assertCreateMarketShape,
  type NotAllowedError,
} from '../aa-call-allowlist';
import { MONAD_TESTNET_ID } from '../chain';
import { makoAbi } from '../MakoMarkets.abi';
import { MAKO_ADDRESS, MarketType } from '../contract';
import { unsettleable } from '../pool-rules';
import { USDC_ADDRESS } from '../usdc';

const SAFE: Address = '0x000000000000000000000000000000000000bEEF';
const NOW_SEC = 1_800_000_000n;
const ref = (s: string) => stringToHex(s, { size: 32 });

const createData = (oracleRef: Hex) =>
  encodeFunctionData({
    abi: makoAbi,
    functionName: 'createMarket',
    args: [MarketType.STOCKS, oracleRef, NOW_SEC + 1800n, NOW_SEC + 3600n, 'q', 1_000_000n, true],
  });
const approve = { to: USDC_ADDRESS, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [MAKO_ADDRESS, maxUint256] }) };

async function reasons(oracleRef: Hex): Promise<string[]> {
  const call = { to: MAKO_ADDRESS, value: 0n, data: createData(oracleRef) };
  const reads = { nowSec: NOW_SEC, readBlocked: async () => false, readCreatorCreatesToday: async () => ({ count: 0n, remaining: 10n }) };
  const out: string[] = [];
  const run = async (f: () => unknown) => {
    try {
      await f();
      out.push('ok');
    } catch (e) {
      out.push((e as NotAllowedError).reason);
    }
  };
  await run(() => assertCreateMarketCall({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, call, ...reads }));
  await run(() => assertCreateMarketShape({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, call }));
  await run(() => assertCreateMarketBatchedCallsSponsor({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, calls: [approve, call], ...reads }));
  await run(() => assertCreateMarketBatchedCallsShape({ chainId: MONAD_TESTNET_ID, safeAddress: SAFE, calls: [approve, call] }));
  return out;
}

describe('BAC / MA: no new pool through the sponsor, none settles on the page', () => {
  it('refuses BAC and MA on every sponsor create path, exact and padded', async () => {
    for (const s of ['BAC:gt:30', 'MA:lt:500', ' BAC :gt:30', 'BAC: gt :+30.5', '\tMA:gt:1\n']) {
      expect(await reasons(ref(s)), s).toEqual(Array(4).fill('bad_create_symbol_paused'));
      expect(unsettleable({ mType: MarketType.STOCKS, oracleRef: ref(s) }), s).toBe(true);
    }
  });
  it('a case variant is refused too, and the resolver cannot settle it either', async () => {
    for (const s of ['bac:gt:30', 'Ma:gt:500']) {
      expect(rwaFeedFor(MarketType.STOCKS, parseRwaRef(ref(s))).ok, s).toBe(false);
      expect(await reasons(ref(s)), s).toEqual(Array(4).fill('bad_create_oracleref_unknown_price_feed_symbol'));
      expect(unsettleable({ mType: MarketType.STOCKS, oracleRef: ref(s) }), s).toBe(true);
    }
  });
  it('the neighbouring stocks are unchanged: created and settleable', async () => {
    for (const s of ['JPM:gt:200', 'V:gt:300', 'AAPL:lt:170', ' MSFT :gt:400']) {
      expect(await reasons(ref(s)), s).toEqual(Array(4).fill('ok'));
      expect(unsettleable({ mType: MarketType.STOCKS, oracleRef: ref(s) }), s).toBe(false);
    }
  });
});
