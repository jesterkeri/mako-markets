// Pool result (18a): the "How results work" steps the pool page shows once betting has opened its way to a result.
// Each line must match the Pools contract and the resolver: the creator's fee is its snapshot of the WHOLE pool,
// paid only above the contract's minimum side ratio; house pools are settled by hand and pay no creator fee; an
// unsettled pool can be force-refunded after 24H, automatically only when one side is empty.

import { describe, expect, it } from 'vitest';
import { stringToHex } from 'viem';

import { computeMinLiquidityRatioBps } from '../bet';
import { MarketType, Outcome, type MarketWithId } from '../contract';
import { resultSteps } from '../pool-rules';

const NOW = 1_800_000_000;
const pool = (over: Partial<MarketWithId> = {}): MarketWithId => ({
  id: 7n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.CRYPTO,
  oracleRef: stringToHex('BTC:gt:80000', { size: 32 }),
  question: 'Will BTC close above $80,000 in 1 day?',
  createdAt: BigInt(NOW - 3_600),
  closeTime: BigInt(NOW + 3 * 3_600),
  bettingCloseTime: BigInt(NOW + 2 * 3_600),
  totalYes: 10_000_000n,
  totalNo: 10_000_000n,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
  ...over,
});
const steps = (m: MarketWithId) => resultSteps(m, Number(computeMinLiquidityRatioBps(BigInt(m.creatorFeeBpsSnapshot))), 'UTC');

describe('resultSteps', () => {
  it('are the four design steps, in order', () => {
    expect(steps(pool()).map((s) => [s.n, s.title])).toEqual([
      ['01', 'Betting closes'],
      ['02', 'Mako Market settles it'],
      ['03', 'Winners claim'],
      ['04', 'Not settled in 24H'],
    ]);
  });

  it('the creator earns its snapshot of the whole pool, above the contract’s minimum side ratio', () => {
    expect(computeMinLiquidityRatioBps(200n)).toBe(408n);
    expect(steps(pool())[2].body).toBe('Claim from the pool page or Me. The creator earns 2% of the whole pool when the smaller side is at least 4.08% of the larger.');
    expect(steps(pool())[2].body).not.toMatch(/smaller side\.$/);
  });

  it('a house pool is settled by hand and pays no creator fee', () => {
    const house = steps(pool({ mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }));
    expect(house[1].body).toBe('Mako Market settles this house pool by hand.');
    expect(house[2].body).toBe('Claim from the pool page or Me. This pool pays no creator fee.');
  });

  it('other pools are settled by the resolver from their source', () => {
    expect(steps(pool())[1].body).toBe('Mako Market’s resolver settles the result from the pool’s source. Nobody reports or votes.');
  });

  it('refunds after 24H: anyone may, the keeper does for one-sided pools; never "everyone is refunded automatically"', () => {
    const body = steps(pool())[3].body;
    expect(body).toContain('Anyone can then mark it refunded');
    expect(body).toContain('bets on one side only');
    expect(body).not.toMatch(/automatically/);
  });

  it('betting close is the pool’s own time', () => {
    expect(steps(pool())[0].body).toMatch(/^At the time set when the pool was created: \w{3} \d{2}:\d{2}\.$/);
  });

  it('no em-dashes, and no we/our/us/team', () => {
    for (const s of [...steps(pool()), ...steps(pool({ mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }))]) {
      expect(`${s.title} ${s.body}`).not.toMatch(/—|\b(we|our|us|team)\b/i);
    }
  });
});
