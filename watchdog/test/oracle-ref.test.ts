import { describe, expect, it } from 'vitest';
import { stringToHex, type Hex } from 'viem';
import { classifyOracleRef } from '../src/oracle-ref';
import { unsupportedOracle, creationFindings } from '../src/classify';
import type { MarketHead } from '../src/abi';

const ref = (s: string): Hex => stringToHex(s, { size: 32 });
const T = { FOOTBALL: 0, CRYPTO: 1, BASKETBALL: 2, FOREX: 3, COMMODITIES: 4, STOCKS: 5, MAKO: 6 };

function head(mType: number, oracleRef: string, extra: Partial<MarketHead> = {}): MarketHead {
  return {
    id: 90, mType, oracleRef, createdAt: 1_000_000, closeTime: 1_086_400, bettingCloseTime: 1_050_000,
    totalYes: 1_000_000n, totalNo: 0n, resolved: false, ...extra,
  };
}

describe('supported references (the resolver would parse them)', () => {
  it.each([
    [T.CRYPTO, 'BTC:gt:100000'],
    [T.CRYPTO, 'ETH:lt:1827'],
    [T.CRYPTO, ' SOL : gt : 102 '], // parts are trimmed
    [T.CRYPTO, 'MON:gt:0x10'], // Number('0x10') = 16: the resolver accepts it, so does the mirror
    [T.FOOTBALL, '560571:over:2.5'],
    [T.FOOTBALL, '1:draw:0'],
    [T.BASKETBALL, '18446:home_win:0'],
    [T.FOREX, 'EURUSD:gt:1.1'],
    [T.FOREX, 'EURGBP:lt:.85'],
    [T.COMMODITIES, 'XAUUSD:lt:2400'],
    [T.STOCKS, 'AAPL:gt:+200'],
  ])('type %i %s', (mType, s) => {
    expect(classifyOracleRef(mType, ref(s)).kind).toBe('supported');
  });
});

describe('unsupported references raise UO', () => {
  it.each([
    [T.CRYPTO, 'BTC:gt', 'wrong part count'],
    [T.CRYPTO, 'BTC:gte:100', 'bad op'],
    [T.CRYPTO, 'PEPE:gt:1', 'unknown symbol'],
    [T.CRYPTO, 'BTC:gt:0', 'non-positive strike'],
    [T.CRYPTO, 'BTC:gt:-5', 'negative strike'],
    [T.CRYPTO, 'BTC:gt:abc', 'non-numeric strike'],
    [T.CRYPTO, 'btc:gt:100', 'lowercase symbol'],
    [T.FOREX, 'AAPL:gt:200', 'class mismatch (stock on forex)'],
    [T.STOCKS, 'EURUSD:gt:1', 'class mismatch (forex on stocks)'],
    [T.FOREX, 'EURUSD:gt:1e3', 'price-feed strike must match the pattern'],
    [T.FOREX, 'EURUSD:gt:0x10', 'price-feed strike hex'],
    [T.COMMODITIES, 'USOIL:gt:70', 'dropped oil symbol'],
    [T.FOOTBALL, 'abc:over:2.5', 'non-digit match id'],
    [T.FOOTBALL, '560571:corners:2', 'bad question type'],
    [T.FOOTBALL, '560571:over:-1', 'negative param'],
    [T.BASKETBALL, '18446:draw:0', 'draw on basketball'],
    [T.CRYPTO, 'BTC:gt:100:extra', 'extra part'],
  ])('type %i %s (%s)', (mType, s) => {
    expect(classifyOracleRef(mType, ref(s)).kind).toBe('unsupported');
  });

  it('all-zero bytes', () => {
    expect(classifyOracleRef(T.CRYPTO, '0x' + '0'.repeat(64)).kind).toBe('unsupported');
  });
  it('non-UTF-8 bytes', () => {
    expect(classifyOracleRef(T.CRYPTO, '0x' + 'ff'.repeat(32)).kind).toBe('unsupported');
    expect(classifyOracleRef(T.FOOTBALL, '0x' + 'c3'.repeat(32)).kind).toBe('unsupported');
  });
  it('a type byte of 7 or more', () => {
    expect(classifyOracleRef(7, ref('BTC:gt:1')).kind).toBe('unsupported');
    expect(classifyOracleRef(255, ref('BTC:gt:1')).kind).toBe('unsupported');
  });
  it('MAKO is exempt whatever its reference', () => {
    expect(classifyOracleRef(T.MAKO, '0x' + '0'.repeat(64)).kind).toBe('exempt');
    expect(classifyOracleRef(T.MAKO, ref('political1')).kind).toBe('exempt');
  });
});

describe('UO line and scope', () => {
  it('names the market as public, with betting window and pools', () => {
    const line = unsupportedOracle(head(T.CRYPTO, ref('PEPE:gt:1')), 1_040_000)!;
    expect(line).toContain('#90 PUBLIC market (CRYPTO): oracle reference not supported, the resolver cannot settle it');
    expect(line).toContain('betting open until');
    expect(line).toContain('pools YES 1.00 / NO 0.00');
    expect(line).not.toContain('—'); // no em-dashes in shipped copy
  });
  it('says betting closed after the cutoff', () => {
    expect(unsupportedOracle(head(T.CRYPTO, ref('PEPE:gt:1')), 1_060_000)).toContain('betting closed');
  });
  it('clears once the market is resolved', () => {
    expect(unsupportedOracle(head(T.CRYPTO, ref('PEPE:gt:1'), { resolved: true }), 1_060_000)).toBeNull();
  });
  it('a paused symbol that parses is a creation alert, not UO', () => {
    const m = head(T.FOREX, ref('EURGBP:gt:0.85'));
    expect(unsupportedOracle(m, 1_040_000)).toBeNull();
    expect(creationFindings(m, false)).toEqual(['NEW #90 FOREX EURGBP: paused symbol, no verified Data Streams feed']);
  });
});
