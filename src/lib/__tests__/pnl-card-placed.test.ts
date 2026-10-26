import jsQR from 'jsqr';
import sharp from 'sharp';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { MAKO_ADDRESS, makoAbi, MarketType, Outcome, type MarketWithId } from '../contract';
import { betLogIndex, cardDate, cardTarget, placedCard, settleDay, sidePx } from '../pnl-card';
import { poolQr } from '../pool-qr';
import { poolUrl } from '../pool-share';

const U = 1_000_000n;
const YESNO = { yes: 'YES', no: 'NO' };
const ACCOUNT = '0x67D68Eb043f5bCf0898719Ad9a886090148032A0';

// Pool #138's shape as read on chain (getMarket, 2026-10-23), reopened for the bet placed card: EURUSD, fees 100 +
// 200 bps, not resolved.
const OPEN: MarketWithId = {
  id: 138n,
  creator: ACCOUNT,
  mType: MarketType.FOREX,
  oracleRef: '0x4555525553443a67743a312e3100000000000000000000000000000000000000',
  question: 'Will EURUSD trade above 1.1 in 5 minutes?',
  createdAt: 1792134704n,
  closeTime: 1792135062n,
  bettingCloseTime: 1792134882n,
  totalYes: 3n * U,
  totalNo: 7n * U,
  yesBettorCount: 2,
  noBettorCount: 3,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
};
const pool = (o: Partial<MarketWithId>): MarketWithId => ({ ...OPEN, ...o });
const BEFORE_CLOSE = 1792134800;
const BET_AT = 1792134750n;

describe('bet placed card', () => {
  it('estimates the bet’s pro-rata share of the pot now, fees included: 1 of 3 YES against 7 NO pays 9.70 / 3', () => {
    // 10 USDC pot less 3% = 9.70; this bet is a third of the YES side: 3.233333 USDC, a return of +223.3%.
    const c = placedCard(OPEN, { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)!;
    expect(c.variant).toBe('placed');
    expect(c.est).toEqual({ payout: '3.23', ret: { sign: '+', text: '223.3%' } });
    expect(c.stake).toBe('1.00');
    expect(c.side).toBe('YES');
    expect(c.isYes).toBe(true);
  });

  it('estimates a NO bet from the NO side: 2 of 7 NO against 3 YES pays 9.70 x 2 / 7', () => {
    const c = placedCard(OPEN, { isYes: false, amount: 2n * U }, YESNO, BET_AT, BEFORE_CLOSE)!;
    expect(c.side).toBe('NO');
    expect(c.isYes).toBe(false);
    expect(c.est).toEqual({ payout: '2.77', ret: { sign: '+', text: '38.6%' } });
  });

  it('shows a loss as the estimate when the fee is more than the other side adds', () => {
    // 100 YES (all this bet) against 0.5 NO: the NO side is too small, so the creator's 2% goes to the winners and only
    // the 1% protocol fee is taken. 100.5 x 0.99 = 99.495 USDC back for 100: -0.5%.
    const c = placedCard(pool({ totalYes: 100n * U, totalNo: U / 2n }), { isYes: true, amount: 100n * U }, YESNO, BET_AT, BEFORE_CLOSE)!;
    expect(c.est?.ret).toEqual({ sign: '-', text: '0.5%' });
    expect(c.est?.payout).toBe('99.50');
  });

  it('drops the estimate while nobody is on the other side', () => {
    expect(placedCard(pool({ totalNo: 0n }), { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)!.est).toBeNull();
  });

  it('has no card once the pool is settled, refunded included, or for an empty bet', () => {
    expect(placedCard(pool({ resolved: true, outcome: Outcome.YES }), { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)).toBeNull();
    expect(placedCard(pool({ resolved: true, outcome: Outcome.REFUND }), { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)).toBeNull();
    expect(placedCard(OPEN, { isYes: true, amount: 0n }, YESNO, BET_AT, BEFORE_CLOSE)).toBeNull();
  });

  it('says the pot is final only once betting has closed', () => {
    const bet = { isYes: true, amount: U };
    expect(placedCard(OPEN, bet, YESNO, BET_AT, Number(OPEN.bettingCloseTime) - 1)!.potFinal).toBe(false);
    expect(placedCard(OPEN, bet, YESNO, BET_AT, Number(OPEN.bettingCloseTime))!.potFinal).toBe(true);
  });

  it('dates the card by the bet and settles it at the pool’s close; no settle date when the resolver cannot read it', () => {
    const c = placedCard(OPEN, { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)!;
    expect(c.date).toBe(cardDate(BET_AT));
    expect(c.settles).toBe(settleDay(OPEN.closeTime));
    const blind = placedCard(pool({ oracleRef: `0x${'00'.repeat(32)}` }), { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)!;
    expect(blind.settles).toBeNull();
  });

  it('uses a house pool’s own side name as the headline, sized to fit', () => {
    const c = placedCard(pool({ mType: MarketType.MAKO }), { isYes: false, amount: U }, { yes: 'Real Madrid', no: 'Barcelona' }, BET_AT, BEFORE_CLOSE)!;
    expect(c.side).toBe('Barcelona');
    expect(c.sidePx).toBe(161);
  });
});

describe('target price', () => {
  // References as read on chain (getMarket, 2026-10-23).
  it('shows a price pool’s target as its title does: BTC #151 "BTC:gt:83368", EURUSD #138 "EURUSD:gt:1.1"', () => {
    expect(cardTarget({ mType: MarketType.CRYPTO, oracleRef: '0x4254433a67743a38333336380000000000000000000000000000000000000000' })).toBe('Above $83,368');
    expect(cardTarget({ mType: MarketType.FOREX, oracleRef: OPEN.oracleRef })).toBe('Above 1.1');
  });

  it('has no target for a sports pool (Hull City #163 "560619:home_win:0") or an unreadable reference', () => {
    expect(cardTarget({ mType: MarketType.FOOTBALL, oracleRef: '0x3536303631393a686f6d655f77696e3a30000000000000000000000000000000' })).toBeNull();
    expect(cardTarget({ mType: MarketType.CRYPTO, oracleRef: `0x${'00'.repeat(32)}` })).toBeNull();
  });

  it('is on both kinds of card', () => {
    expect(placedCard(OPEN, { isYes: true, amount: U }, YESNO, BET_AT, BEFORE_CLOSE)!.target).toBe('Above 1.1');
  });
});

describe('formatting', () => {
  it('writes the settle day as "Sat 24 Oct" in UTC', () => {
    expect(settleDay(BigInt(Date.UTC(2026, 9, 24, 12) / 1000))).toBe('Sat 24 Oct');
    expect(settleDay(BigInt(Date.UTC(2026, 10, 7, 23, 59) / 1000))).toBe('Sat 7 Nov');
  });

  it('keeps YES and NO at the design’s 186px and steps a long side name down to end within 900px', () => {
    expect(sidePx('YES')).toBe(186);
    expect(sidePx('NO')).toBe(186);
    for (const n of [5, 8, 10]) expect(sidePx('X'.repeat(n)) * 0.62 * n).toBeLessThanOrEqual(900);
  });
});

describe('the confirmation finds its bet in the receipt', () => {
  const log = (o: { id?: bigint; user?: Hex; address?: string; logIndex?: number | null } = {}) => ({
    address: o.address ?? MAKO_ADDRESS.toLowerCase(),
    logIndex: o.logIndex === undefined ? 5 : o.logIndex,
    topics: encodeEventTopics({ abi: makoAbi, eventName: 'BetPlaced', args: { id: o.id ?? 138n, user: o.user ?? ACCOUNT } }) as Hex[],
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [true, U]),
  });
  const transfer = { address: '0x534b2f3A21130d7a60830c2Df862319e593943A3', logIndex: 4, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] as Hex[], data: '0x' as Hex };

  it('names the one BetPlaced log for this pool and account, among other logs', () => {
    expect(betLogIndex([transfer, log()], 138n, ACCOUNT.toLowerCase())).toBe(5);
  });

  it('finds nothing for another pool, another account, another contract, or a pending log', () => {
    expect(betLogIndex([log({ id: 139n })], 138n, ACCOUNT)).toBeNull();
    expect(betLogIndex([log({ user: '0x0000000000000000000000000000000000000001' })], 138n, ACCOUNT)).toBeNull();
    expect(betLogIndex([log({ address: '0x0000000000000000000000000000000000000002' })], 138n, ACCOUNT)).toBeNull();
    expect(betLogIndex([log({ logIndex: null })], 138n, ACCOUNT)).toBeNull();
  });

  it('never guesses between two bets in one transaction', () => {
    expect(betLogIndex([log({ logIndex: 5 }), log({ logIndex: 9 })], 138n, ACCOUNT)).toBeNull();
  });
});

describe('the bet placed card’s QR code', () => {
  it('decodes to the pool’s page', async () => {
    const url = await poolQr(138n);
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64');
    // Rendered with a white quiet zone, as a scanner sees it on the card's cream tile.
    const { data, info } = await sharp(svg, { density: 300 }).resize(330, 330).extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#EDE6D6' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const read = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    expect(read?.data).toBe(poolUrl(138n));
  });
});
