// Creator earnings (src/lib/creator-earnings.ts): the forfeit math against vectors the contract itself computed, the
// fee formula, and the state of a pool for its creator. The vectors are the proof; the spot cases below restate the
// boundaries in plain numbers so a reader can check them by hand.

import { describe, expect, it } from 'vitest';

import { computeMinLiquidityRatioBps, isCreatorFeeForfeited } from '../bet';
import { MarketType, Outcome, type MarketWithId } from '../contract';
import {
  creatorEarningNote,
  creatorEarningOf,
  creatorEarningsFor,
  creatorFeeAmount,
  creatorFeeForfeited,
  isPoolCreator,
  ratioPct,
} from '../creator-earnings';
import { FORFEIT_VECTORS } from './creator-fee-forfeit-vectors';

const USDC = 1_000_000n;
const CREATOR = '0x00000000000000000000000000000000000000C1';
const OTHER = '0x00000000000000000000000000000000000000d2';

function pool(over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id: 7n,
    creator: CREATOR,
    mType: MarketType.CRYPTO,
    oracleRef: `0x${'00'.repeat(32)}`,
    question: 'Will BTC close above $80,000 in 1 day?',
    createdAt: 1n,
    closeTime: 2n,
    bettingCloseTime: 2n,
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.YES,
    resolved: true,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

describe('forfeit math vs the contract (vectors from MakoMarketsV4 itself)', () => {
  it('has the full generated set', () => {
    expect(FORFEIT_VECTORS.length).toBe(136);
    expect(new Set(FORFEIT_VECTORS.map((v) => v.snap))).toEqual(new Set([0, 1, 50, 100, 200, 250, 300, 500]));
  });

  it.each(FORFEIT_VECTORS.map((v) => [`snap ${v.snap}: yes ${v.yes} / no ${v.no}`, v] as const))('%s', (_, v) => {
    expect(computeMinLiquidityRatioBps(BigInt(v.snap))).toBe(v.ratioBps);
    expect(creatorFeeForfeited(v.yes, v.no, BigInt(v.snap))).toBe(v.forfeited);
    expect(creatorFeeAmount(v.yes, v.no, BigInt(v.snap))).toBe(v.fee);
  });

  it('agrees with bet.ts for every non-zero snapshot (bet.ts only differs at snapshot 0, where the fee is 0)', () => {
    for (const v of FORFEIT_VECTORS) {
      if (v.snap === 0) {
        expect(v.fee).toBe(0n);
        continue;
      }
      expect(isCreatorFeeForfeited(v.yes, v.no, BigInt(v.snap))).toBe(v.forfeited);
    }
  });
});

describe('forfeit boundaries at the live 2% fee, by hand', () => {
  // ratio(200) = max(100, 2 * floor(10000 * 200 / 9800)) = 2 * 204 = 408 bps. Forfeited iff smaller * 10000 < larger * 408.
  it('the 2% pool threshold is 408 bps', () => {
    expect(computeMinLiquidityRatioBps(200n)).toBe(408n);
  });
  it('exactly at the ratio is NOT forfeited; one unit under is; one unit over is not', () => {
    expect(creatorFeeForfeited(408_000n, 10n * USDC, 200n)).toBe(false);
    expect(creatorFeeForfeited(407_999n, 10n * USDC, 200n)).toBe(true);
    expect(creatorFeeForfeited(408_001n, 10n * USDC, 200n)).toBe(false);
  });
  it('is symmetric in the sides', () => {
    expect(creatorFeeForfeited(10n * USDC, 407_999n, 200n)).toBe(true);
    expect(creatorFeeForfeited(10n * USDC, 408_000n, 200n)).toBe(false);
  });
  it('one side zero is never forfeited (the fee is payable on a one-sided YES/NO pool)', () => {
    expect(creatorFeeForfeited(0n, 10n * USDC, 200n)).toBe(false);
    expect(creatorFeeForfeited(10n * USDC, 0n, 200n)).toBe(false);
    expect(creatorFeeForfeited(0n, 0n, 200n)).toBe(false);
  });
  it('the fee rounds down like the contract', () => {
    expect(creatorFeeAmount(135_999n, 3_333_333n, 200n)).toBe(69_386n);
  });
});

describe('creatorEarningOf: one state per pool', () => {
  it('claimable: resolved YES, two-sided enough, not claimed. Fee = 40 USDC * 2% = 0.80', () => {
    const e = creatorEarningOf(pool())!;
    expect(e.state).toBe('claimable');
    expect(e.fee).toBe(800_000n);
  });
  it('claimable on a NO result too', () => {
    expect(creatorEarningOf(pool({ outcome: Outcome.NO }))!.state).toBe('claimable');
  });
  it('claimable on a one-sided YES result (contract pays it)', () => {
    expect(creatorEarningOf(pool({ totalNo: 0n }))!.state).toBe('claimable');
  });
  it('claimed: the contract flag is set and the fee was not forfeited', () => {
    const e = creatorEarningOf(pool({ creatorFeeClaimed: true }))!;
    expect(e.state).toBe('claimed');
    expect(e.fee).toBe(800_000n);
  });
  it('forfeited: one unit under the ratio, whether or not claim was called', () => {
    const skew = { totalYes: 10n * USDC, totalNo: 407_999n };
    expect(creatorEarningOf(pool(skew))!.state).toBe('forfeited');
    expect(creatorEarningOf(pool({ ...skew, creatorFeeClaimed: true }))!.state).toBe('forfeited');
  });
  it('not forfeited exactly at the ratio', () => {
    expect(creatorEarningOf(pool({ totalYes: 10n * USDC, totalNo: 408_000n }))!.state).toBe('claimable');
  });
  it('refunded: REFUND outcome, even when the totals would be forfeited', () => {
    expect(creatorEarningOf(pool({ outcome: Outcome.REFUND }))!.state).toBe('refunded');
    expect(creatorEarningOf(pool({ outcome: Outcome.REFUND, totalNo: 1n }))!.state).toBe('refunded');
  });
  it('unresolved: no result yet', () => {
    expect(creatorEarningOf(pool({ resolved: false, outcome: Outcome.UNRESOLVED }))!.state).toBe('unresolved');
  });
  it('never listed: MAKO pools, a 0 snapshot, a fee that rounds to 0', () => {
    expect(creatorEarningOf(pool({ mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }))).toBeNull();
    expect(creatorEarningOf(pool({ mType: MarketType.MAKO }))).toBeNull();
    expect(creatorEarningOf(pool({ creatorFeeBpsSnapshot: 0 }))).toBeNull();
    expect(creatorEarningOf(pool({ totalYes: 49n, totalNo: 0n }))).toBeNull();
  });
});

describe('creatorEarningsFor: the account\'s own pools', () => {
  const markets = [
    pool({ id: 1n }),
    pool({ id: 2n, creator: OTHER }),
    pool({ id: 3n, creatorFeeClaimed: true }),
    pool({ id: 4n, totalNo: 1n }),
    pool({ id: 5n, outcome: Outcome.REFUND }),
    pool({ id: 6n, resolved: false, outcome: Outcome.UNRESOLVED }),
    pool({ id: 8n, totalYes: 5n * USDC, totalNo: 5n * USDC }),
    pool({ id: 9n, mType: MarketType.MAKO, creatorFeeBpsSnapshot: 0 }),
  ];
  it('lists only pools the account created, compared case-insensitively, claimable first', () => {
    const r = creatorEarningsFor(markets, CREATOR.toLowerCase());
    expect(r.rows.map((e) => [e.market.id, e.state])).toEqual([
      [8n, 'claimable'],
      [1n, 'claimable'],
      [3n, 'claimed'],
      [4n, 'forfeited'],
      [5n, 'refunded'],
      [6n, 'unresolved'],
    ]);
  });
  it('totals the claimable fees only: 0.80 + 10 * 2% = 1.00 USDC', () => {
    const r = creatorEarningsFor(markets, CREATOR);
    expect(r.claimable).toBe(2);
    expect(r.claimableTotal).toBe(1_000_000n);
  });
  it('an account that created nothing gets nothing', () => {
    expect(creatorEarningsFor(markets, '0x00000000000000000000000000000000000000ff')).toEqual({ rows: [], claimableTotal: 0n, claimable: 0 });
  });
  it('isPoolCreator needs an account', () => {
    expect(isPoolCreator(pool(), null)).toBe(false);
    expect(isPoolCreator(pool(), CREATOR.toLowerCase())).toBe(true);
    expect(isPoolCreator(pool(), OTHER)).toBe(false);
  });
});

describe('creatorEarningNote', () => {
  it('explains a forfeit with the real numbers', () => {
    const e = creatorEarningOf(pool({ totalYes: 10n * USDC, totalNo: 407_999n }))!;
    expect(creatorEarningNote(e)).toBe(
      'Forfeited: the smaller side (0.407999 USDC) was under 4.08% of the larger (10.00 USDC), so the 0.208159 USDC creator share went to the winners.',
    );
  });
  it('no note uses an em dash', () => {
    for (const s of ['claimable', 'claimed', 'refunded', 'unresolved'] as const) {
      const m = s === 'claimed' ? pool({ creatorFeeClaimed: true }) : s === 'refunded' ? pool({ outcome: Outcome.REFUND }) : s === 'unresolved' ? pool({ resolved: false }) : pool();
      expect(creatorEarningNote(creatorEarningOf(m)!)).not.toMatch(/—/);
    }
  });
  it('ratioPct prints bps as a percentage', () => {
    expect(ratioPct(408n)).toBe('4.08');
    expect(ratioPct(100n)).toBe('1');
    expect(ratioPct(1052n)).toBe('10.52');
    expect(ratioPct(250n)).toBe('2.5');
  });
});
