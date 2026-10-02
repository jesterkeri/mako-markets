// The pool page reads a settlement reference exactly as the resolver does (Codex S3 r1 MAJOR 2). The contract
// stores any reference a direct createMarket call passes, so for one the resolver rejects the page states no YES/NO
// rule or price source, says plainly that the pool cannot be settled by price or result, and takes no in-app bet.
// Expected verdicts are from cf-worker/src/index.ts (parseCryptoOracleRef, parsePriceFeedOracleRef,
// parseFootballOracleRef, parseBasketballOracleRef) as deployed at 46c5777.

import { describe, expect, it } from 'vitest';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { betBlocker } from '../pool-bet-rules';
import { parseOracleRef, poolRules, unsettleable, UNSETTLEABLE_LINE } from '../pool-rules';

const NOW = 1_800_000_000;
const pool = (mType: number, ref: string): MarketWithId => ({
  id: 9n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType,
  oracleRef: stringToHex(ref, { size: 32 }),
  question: 'Q?',
  createdAt: BigInt(NOW - 3600),
  closeTime: BigInt(NOW + 7200),
  bettingCloseTime: BigInt(NOW + 3600),
  totalYes: 0n,
  totalNo: 0n,
  yesBettorCount: 0,
  noBettorCount: 0,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
});

const READ: [string, number, string][] = [
  ['listed crypto', MarketType.CRYPTO, 'BTC:gt:80000'],
  ['crypto, exponent strike (Number() reads it, as the resolver does)', MarketType.CRYPTO, 'ETH:lt:1e3'],
  ['forex in its class', MarketType.FOREX, 'EURUSD:gt:1.08'],
  ['stock in its class', MarketType.STOCKS, 'TSLA:gt:250'],
  ['football', MarketType.FOOTBALL, '12345:home_win:0'],
  ['basketball', MarketType.BASKETBALL, '678:over:210.5'],
];
const REJECTED: [string, number, string][] = [
  ['unlisted crypto symbol', MarketType.CRYPTO, 'PEPE:gt:1'],
  ['crypto symbol in the wrong case', MarketType.CRYPTO, 'btc:gt:80000'],
  ['crypto, Infinity strike', MarketType.CRYPTO, 'BTC:gt:Infinity'],
  ['crypto, zero strike', MarketType.CRYPTO, 'BTC:gt:0'],
  ['made-up stock', MarketType.STOCKS, 'MADEUP:gt:1'],
  ['a forex symbol on a STOCKS pool (wrong class)', MarketType.STOCKS, 'EURUSD:gt:1'],
  ['stock, exponent strike (the feed grammar refuses it)', MarketType.STOCKS, 'TSLA:gt:1e3'],
  ['stock, hex strike', MarketType.STOCKS, 'TSLA:gt:0x10'],
  ['football, non-numeric match id', MarketType.FOOTBALL, 'abc:home_win:0'],
  ['basketball cannot be a draw', MarketType.BASKETBALL, '678:draw:0'],
  ['wrong comparator', MarketType.CRYPTO, 'BTC:eq:80000'],
];

describe('parseOracleRef mirrors the resolver', () => {
  it.each(READ)('reads %s', (_name, mType, ref) => {
    expect(parseOracleRef(pool(mType, ref))).not.toBeNull();
    expect(unsettleable(pool(mType, ref))).toBe(false);
  });
  it.each(REJECTED)('rejects %s', (_name, mType, ref) => {
    expect(parseOracleRef(pool(mType, ref))).toBeNull();
    expect(unsettleable(pool(mType, ref))).toBe(true);
  });
  it('shows a crypto exponent strike as the number it is', () => {
    expect(parseOracleRef(pool(MarketType.CRYPTO, 'ETH:lt:1e3'))).toMatchObject({ symbol: 'ETH', strike: '1000' });
  });
  it('a house pool is settled by hand and is never unsettleable', () => {
    expect(unsettleable(pool(MarketType.MAKO, 'anything'))).toBe(false);
  });
});

describe('a pool the resolver cannot read', () => {
  const bad = pool(MarketType.STOCKS, 'MADEUP:gt:1');
  it('gets a WARNING line and no YES/NO rule or price source', () => {
    const lines = poolRules(bad, 'UTC');
    expect(lines.find((l) => l.k === 'WARNING')?.v).toBe(UNSETTLEABLE_LINE);
    expect(lines.some((l) => l.k === 'YES' || l.k === 'NO')).toBe(false);
    expect(lines.find((l) => l.k === 'SOURCE')?.v).toBe('None the resolver can read.');
    expect(JSON.stringify(lines)).not.toMatch(/Pyth|CoinGecko/);
  });
  it('takes no in-app bet', () => {
    expect(betBlocker({ m: bad, nowSec: NOW, amount: 1_000_000n, balance: 10_000_000n, mine: { yes: 0n, no: 0n }, limits: null })).toBe(UNSETTLEABLE_LINE);
  });
  it('a readable pool is unaffected', () => {
    const ok = pool(MarketType.STOCKS, 'TSLA:gt:250');
    expect(poolRules(ok, 'UTC').some((l) => l.k === 'WARNING')).toBe(false);
    expect(betBlocker({ m: ok, nowSec: NOW, amount: 1_000_000n, balance: 10_000_000n, mine: { yes: 0n, no: 0n }, limits: null })).toBeNull();
  });
});
