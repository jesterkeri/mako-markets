import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, parseAbi, stringToHex } from 'viem';
import { aggregate3GetMarkets, decodeAggregate3, decodeMarketHead, getMarketCalldata } from '../src/abi';
import { MULTICALL3 } from '../src/config';
import markets from './fixtures/markets.json';
import agg from './fixtures/aggregate3.json';
import { encodeMarket, MAKO } from './fake';

// Fixtures: raw getMarket and aggregate3 return data read from Monad testnet
// (V4 0xbC5A58...26195) at a finalized block; provenance in each file.

const M = markets.markets as Record<string, string>;

describe('getMarket head words, real chain fixtures', () => {
  it('market 7: MAKO, resolved REFUND, one-sided', () => {
    const h = decodeMarketHead(7, M['7']);
    expect(h).toMatchObject({ id: 7, mType: 6, createdAt: 1779393148, closeTime: 1779396738, bettingCloseTime: 1779396438, resolved: true });
    expect(h.totalYes).toBe(300000n);
    expect(h.totalNo).toBe(0n);
  });
  it('market 74: CRYPTO ETH:lt:1827, two-sided, resolved', () => {
    const h = decodeMarketHead(74, M['74']);
    expect(h.mType).toBe(1);
    expect(h.oracleRef).toBe(stringToHex('ETH:lt:1827', { size: 32 }));
    expect(h.totalYes).toBe(5000000n);
    expect(h.totalNo).toBe(5000000n);
    expect(h.resolved).toBe(true);
  });
  it('markets 77, 79, 81: COMMODITIES, FOOTBALL, STOCKS', () => {
    expect(decodeMarketHead(77, M['77']).mType).toBe(4);
    expect(decodeMarketHead(79, M['79'])).toMatchObject({ mType: 0, closeTime: 1788616800 });
    expect(decodeMarketHead(81, M['81'])).toMatchObject({ mType: 5, closeTime: 1789201167, resolved: true });
  });
  it('market 85: open CRYPTO market', () => {
    expect(decodeMarketHead(85, M['85'])).toMatchObject({ mType: 1, resolved: false, closeTime: 1790284093 });
  });
  it('a nonexistent id decodes to closeTime 0', () => {
    expect(decodeMarketHead(10000, M['10000']).closeTime).toBe(0);
    expect(decodeMarketHead(86, M['86']).closeTime).toBe(0);
  });
  it('rejects truncated, mis-offset and out-of-range data', () => {
    const good = M['74'];
    expect(() => decodeMarketHead(1, good.slice(0, 500))).toThrow();
    expect(() => decodeMarketHead(1, '0x' + '0'.repeat(62) + '40' + good.slice(66))).toThrow(); // offset 0x40
    const badBool = good.slice(0, 2 + 64 * 13) + '0'.repeat(63) + '2' + good.slice(2 + 64 * 14);
    expect(() => decodeMarketHead(1, badBool)).toThrow();
  });
});

describe('aggregate3', () => {
  it('calldata matches viem for the same calls', () => {
    const abi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
    const ids = [0, 1, 49, 1999];
    const viem = encodeFunctionData({
      abi,
      functionName: 'aggregate3',
      args: [ids.map((id) => ({ target: MAKO as `0x${string}`, allowFailure: true, callData: getMarketCalldata(id) as `0x${string}` }))],
    });
    expect(aggregate3GetMarkets(MAKO, ids)).toBe(viem.toLowerCase());
  });
  it('decodes a real aggregate3 response of 28 getMarket calls', () => {
    const out = decodeAggregate3(agg.result, agg.ids.length);
    expect(out).toHaveLength(28);
    const heads = out.map((d, i) => decodeMarketHead(agg.ids[i], d!));
    expect(heads.find((h) => h.id === 74)!.totalNo).toBe(5000000n);
    // ids 86 and 87 were beyond nextMarketId (86) at the time: zero markets.
    expect(heads.find((h) => h.id === 86)!.closeTime).toBe(0);
    expect(heads.find((h) => h.id === 85)!.closeTime).toBeGreaterThan(0);
  });
  it('decodes failed calls as null and rejects a length mismatch', () => {
    const encoded = decodeAggregate3(
      // one success, one failure, built with viem in the fake
      encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }], [[[true, encodeMarket(null)], [false, '0x']]]),
      2,
    );
    expect(encoded[1]).toBeNull();
    expect(() => decodeAggregate3(agg.result, 27)).toThrow();
  });
  it('points at Multicall3', () => {
    expect(MULTICALL3).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });
});
