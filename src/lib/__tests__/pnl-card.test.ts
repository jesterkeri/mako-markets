import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '../contract';
import { betPayout, cardDate, cardPath, pnlCard, questionPx, returnPct, shortSide, signedAmount } from '../pnl-card';

const U = 1_000_000n;
const YESNO = { yes: 'YES', no: 'NO' };

// Pool #138 as read on chain (getMarket, 2026-10-23): EURUSD, 1 USDC each side, YES won, fees 100 + 200 bps.
const POOL_138: MarketWithId = {
  id: 138n,
  creator: '0x67D68Eb043f5bCf0898719Ad9a886090148032A0',
  mType: MarketType.FOREX,
  oracleRef: '0x4555525553443a67743a312e3100000000000000000000000000000000000000',
  question: 'Will EURUSD trade above 1.1 in 5 minutes?',
  createdAt: 1792134704n,
  closeTime: 1792135062n,
  bettingCloseTime: 1792134882n,
  totalYes: U,
  totalNo: U,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.YES,
  resolved: true,
  creatorFeeClaimed: true,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};

const pool = (o: Partial<MarketWithId>): MarketWithId => ({ ...POOL_138, ...o });

describe('per-bet payout', () => {
  it('pays a winning bet its pro-rata share of the pool after fees (pool #138: 2 USDC less 3% = 1.94)', () => {
    expect(betPayout(POOL_138, { isYes: true, amount: U })).toBe(1_940_000n);
  });

  it('pays a losing bet 0', () => {
    expect(betPayout(POOL_138, { isYes: false, amount: U })).toBe(0n);
  });

  it('has no payout for a refunded or unresolved pool', () => {
    expect(betPayout(pool({ outcome: Outcome.REFUND }), { isYes: true, amount: U })).toBeNull();
    expect(betPayout(pool({ resolved: false, outcome: Outcome.UNRESOLVED }), { isYes: true, amount: U })).toBeNull();
    expect(pnlCard(pool({ outcome: Outcome.REFUND }), { isYes: true, amount: U }, YESNO)).toBeNull();
  });

  it('two bets on the same side are two cards, each priced on its own amount', () => {
    // 3 + 7 USDC on YES, 10 on NO, 3% fee: the side pays 19.4 for 10, so 1.94x each.
    const m = pool({ totalYes: 10n * U, totalNo: 10n * U });
    const a = pnlCard(m, { isYes: true, amount: 3n * U }, YESNO)!;
    const b = pnlCard(m, { isYes: true, amount: 7n * U }, YESNO)!;
    expect([a.stake, a.payout, a.net, a.ret]).toEqual(['3.00', '5.82', { sign: '+', text: '2.82' }, { sign: '+', text: '94%' }]);
    expect([b.stake, b.payout, b.net, b.ret]).toEqual(['7.00', '13.58', { sign: '+', text: '6.58' }, { sign: '+', text: '94%' }]);
    // Together never more than the side's whole claim (each share rounds down).
    expect(betPayout(m, { isYes: true, amount: 3n * U })! + betPayout(m, { isYes: true, amount: 7n * U })!).toBeLessThanOrEqual(betPayout(m, { isYes: true, amount: 10n * U })!);
  });

  it('a bet on each side of one pool: the winning side is a win card, the other a loss card', () => {
    const m = pool({ totalYes: 5n * U, totalNo: 5n * U, outcome: Outcome.NO });
    const yes = pnlCard(m, { isYes: true, amount: 2n * U }, YESNO)!;
    const no = pnlCard(m, { isYes: false, amount: 3n * U }, YESNO)!;
    expect([yes.variant, yes.side, yes.payout, yes.net, yes.netWord, yes.ret]).toEqual(['loss', 'YES', '0.00', { sign: '-', text: '2.00' }, 'loss', { sign: '-', text: '100%' }]);
    expect([no.variant, no.side, no.stake, no.payout, no.netWord, no.ret]).toEqual(['win', 'NO', '3.00', '5.82', 'profit', { sign: '+', text: '94%' }]);
  });

  it('a winning bet that pays less than its stake is a win card with honest negative figures', () => {
    // 100 on YES against 0.5 on NO, 1% protocol fee, no creator fee: the side gets 99.495 back.
    const m = pool({ totalYes: 100n * U, totalNo: U / 2n, protocolFeeBpsSnapshot: 100, creatorFeeBpsSnapshot: 0 });
    const c = pnlCard(m, { isYes: true, amount: 100n * U }, YESNO)!;
    expect([c.variant, c.payout, c.net, c.netWord, c.ret]).toEqual(['win', '99.50', { sign: '-', text: '0.51' }, 'loss', { sign: '-', text: '0.5%' }]);
  });
});

describe('formatting', () => {
  it('formats the approved designs exactly', () => {
    const win = pnlCard(pool({ totalYes: 10n * U, totalNo: 10n * U }), { isYes: true, amount: 10n * U }, YESNO)!;
    expect(returnPct(16_170_000n, 10n * U)).toEqual({ sign: '+', text: '61.7%' });
    expect(signedAmount(6_170_000n)).toEqual({ sign: '+', text: '6.17' });
    expect(returnPct(0n, 10n * U)).toEqual({ sign: '-', text: '100%' });
    expect(signedAmount(-10n * U)).toEqual({ sign: '-', text: '10.00' });
    expect(win.category).toBe('The call · FOREX pool');
    expect(win.date).toBe('16 OCT 2026');
  });

  it('drops a trailing .0 and rounds half away from zero', () => {
    expect(returnPct(15n * U, 10n * U).text).toBe('50%');
    expect(returnPct(10_005_000n, 10n * U)).toEqual({ sign: '+', text: '0.1%' }); // +0.05% rounds up
    expect(returnPct(10_004_999n, 10n * U)).toEqual({ sign: '', text: '0%' });
    expect(returnPct(9_995_000n, 10n * U)).toEqual({ sign: '-', text: '0.1%' });
    expect(returnPct(10n * U, 10n * U)).toEqual({ sign: '', text: '0%' });
    expect(signedAmount(4_000n)).toEqual({ sign: '', text: '0.00' });
  });

  it('dates in UTC with a two-digit day', () => {
    expect(cardDate(1793491200n)).toBe('01 NOV 2026'); // 2026-11-01T00:00:00Z
    expect(cardDate(1793491199n)).toBe('31 OCT 2026');
  });

  it('steps a long question down so two lines end above the Return block', () => {
    expect(questionPx('Will Arsenal win on Saturday?')).toBe(66);
    const q90 = 'Will Bitcoin close above 125,000 USD on Coinbase at the end of trading on Friday 31 October?';
    expect([...q90].length).toBeGreaterThanOrEqual(88);
    expect(questionPx(q90)).toBe(40);
    // 150 (label top) + ~20 (label) + 12 + two lines at line-height 1 ends at least 16px above the Return label (300).
    for (const n of [33, 64, 65, 80, 81, 200]) expect(150 + 20 + 12 + 2 * questionPx('x'.repeat(n))).toBeLessThanOrEqual(284);
  });

  it('uses a house pool’s own side names, shortened to fit', () => {
    expect(shortSide('Arsenal')).toBe('Arsenal');
    expect(shortSide('Manchester United')).toBe('Mancheste…');
    const c = pnlCard(pool({ mType: MarketType.MAKO }), { isYes: false, amount: U }, { yes: 'Real Madrid', no: 'Barcelona' })!;
    expect(c.side).toBe('Barcelona');
  });

  it('builds the card path with a lower-case hash', () => {
    expect(cardPath(138n, '0xABCD', 5)).toBe('/pools/138/pnl/0xabcd/5');
  });
});
