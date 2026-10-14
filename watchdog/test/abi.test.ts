import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbi, stringToHex } from 'viem';
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

// Review r1 finding 2: the decoder must reject any ABI-invalid or
// non-canonical return, not only validate the fields it uses.
describe('strict decoding: mutations of a real getMarket return', () => {
  const good = M['74'].slice(2); // 640 bytes: 32 + 16 words + length + 2 words of question
  const w = (k: number) => 64 + 64 * k; // hex index of tuple word k
  const setWord = (h: string, hexIdx: number, v: bigint) => h.slice(0, hexIdx) + v.toString(16).padStart(64, '0') + h.slice(hexIdx + 64);
  const reject = (h: string) => expect(() => decodeMarketHead(1, '0x' + h)).toThrow();

  it('accepts the unmodified return', () => {
    expect(decodeMarketHead(74, '0x' + good).closeTime).toBe(1786000193);
  });
  it('the 17-word prefix alone, question offset past the end', () => {
    reject(good.slice(0, 2 * (32 + 16 * 32)));
    reject(setWord(good.slice(0, 2 * (32 + 17 * 32)), w(3), 10_000n));
  });
  it('question tail missing, truncated or with nonzero padding', () => {
    reject(good.slice(0, 2 * (32 + 17 * 32))); // length word only
    reject(good.slice(0, good.length - 64)); // last padded word cut
    reject(good.slice(0, good.length - 2) + '01'); // padding not zero
  });
  it('non-canonical, unaligned or overlapping question offset', () => {
    reject(setWord(good, w(3), 0x220n) + '0'.repeat(64)); // shifted, tail present
    reject(setWord(good, w(3), 0x201n));
    reject(setWord(good, w(3), 0x1e0n)); // points into the head
  });
  it('trailing data', () => {
    reject(good + '0'.repeat(64));
  });
  it('fields outside their Solidity widths', () => {
    reject(setWord(good, w(0), 1n << 160n)); // address
    reject(setWord(good, w(1), 256n)); // uint8 enum
    reject(setWord(good, w(4), 1n << 53n)); // time beyond a safe integer
    reject(setWord(good, w(9), 1n << 32n)); // uint32
    reject(setWord(good, w(11), 4n)); // Outcome enum
    reject(setWord(good, w(12), 2n)); // bool resolved
    reject(setWord(good, w(13), 2n)); // bool creatorFeeClaimed
    reject(setWord(good, w(15), 1n << 16n)); // uint16
    reject(setWord(good, 64 + 64 * 16, 201n)); // question longer than V4 allows
  });
});

describe('strict decoding: mutations of a real aggregate3 return', () => {
  const good = agg.result.slice(2);
  const setWord = (h: string, byte: number, v: bigint) => h.slice(0, byte * 2) + v.toString(16).padStart(64, '0') + h.slice(byte * 2 + 64);
  const reject = (h: string, n = agg.ids.length) => expect(() => decodeAggregate3('0x' + h, n)).toThrow();
  const off0 = Number(BigInt('0x' + good.slice(128, 192)));

  it('entry 1 aliased to entry 0', () => {
    reject(setWord(good, 64 + 32, BigInt(off0)));
  });
  it('bytes member not at 0x40', () => {
    reject(setWord(good, 64 + off0 + 32, 0x60n));
  });
  it('trailing data and nonzero padding', () => {
    reject(good + '0'.repeat(64));
    const t = 64 + off0;
    const len = Number(BigInt('0x' + good.slice((t + 64) * 2, (t + 96) * 2)));
    // Shorten entry 0 by one byte and make that byte, now padding, nonzero.
    const lastByte = (t + 96 + len - 1) * 2;
    const shortened = setWord(good, t + 64, BigInt(len - 1));
    reject(shortened.slice(0, lastByte) + '01' + shortened.slice(lastByte + 2));
    // Shortened with zero padding is a valid aggregate3 encoding, but the
    // market inside it is no longer a valid getMarket return.
    const valid = decodeAggregate3('0x' + shortened, agg.ids.length);
    expect(() => decodeMarketHead(agg.ids[0], valid[0]!)).toThrow();
  });
  it('array offset not 0x20', () => {
    reject(setWord(good, 0, 0x40n));
  });
});

describe('strict decoding agrees with viem on valid encodings', () => {
  it('200 random markets decode to the same fields', () => {
    const tuple = [{ type: 'tuple', components: [
      { name: 'creator', type: 'address' }, { name: 'mType', type: 'uint8' }, { name: 'oracleRef', type: 'bytes32' },
      { name: 'question', type: 'string' }, { name: 'createdAt', type: 'uint64' }, { name: 'closeTime', type: 'uint64' },
      { name: 'bettingCloseTime', type: 'uint64' }, { name: 'totalYes', type: 'uint256' }, { name: 'totalNo', type: 'uint256' },
      { name: 'yesBettorCount', type: 'uint32' }, { name: 'noBettorCount', type: 'uint32' }, { name: 'outcome', type: 'uint8' },
      { name: 'resolved', type: 'bool' }, { name: 'creatorFeeClaimed', type: 'bool' },
      { name: 'protocolFeeBpsSnapshot', type: 'uint16' }, { name: 'creatorFeeBpsSnapshot', type: 'uint16' },
    ] }] as const;
    let seed = 7;
    const r = (k: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);
    for (let i = 0; i < 200; i++) {
      const v = {
        creator: `0x${r(1 << 30).toString(16).padStart(40, '0')}` as `0x${string}`,
        mType: r(7), oracleRef: stringToHex(`BTC:gt:${r(99999)}`, { size: 32 }), question: 'q'.repeat(1 + r(200)),
        ...(() => {
          // V4 timings: duration in [5 min, 7 days], betting close inside it.
          const createdAt = 1_700_000_000 + r(1e8);
          const duration = 300 + r(604_800 - 300);
          const closeTime = createdAt + duration;
          return {
            createdAt: BigInt(createdAt),
            closeTime: BigInt(closeTime),
            bettingCloseTime: BigInt(createdAt + 1 + r(duration)),
          };
        })(),
        totalYes: BigInt(r(1e9)) * 10n ** 12n, totalNo: BigInt(r(1e9)), yesBettorCount: r(1000), noBettorCount: r(1000), outcome: r(4),
        resolved: r(2) === 1, creatorFeeClaimed: r(2) === 1, protocolFeeBpsSnapshot: r(500), creatorFeeBpsSnapshot: r(500),
      };
      const enc = encodeAbiParameters(tuple, [v]);
      const [back] = decodeAbiParameters(tuple, enc);
      const h = decodeMarketHead(i, enc, Number(v.createdAt) + 1);
      expect(h).toEqual({
        id: i, mType: back.mType, oracleRef: back.oracleRef, createdAt: Number(back.createdAt), closeTime: Number(back.closeTime),
        bettingCloseTime: Number(back.bettingCloseTime), totalYes: back.totalYes, totalNo: back.totalNo, resolved: back.resolved,
      });
    }
  });
});
