// The pool invite card (15a adapted to pools): the link it shares, the share-intent URLs, and what the card says.

import { describe, expect, it } from 'vitest';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { intentUrl, linkDisplay, poolInviteCard, poolInviteLink, SHARE_ORIGIN, shareText, type ShareTarget } from '@/lib/pool-invite';
import { formatPays, poolRow } from '@/lib/pool-list';
import { poolClock } from '@/lib/pool-rules';
import { refFromSearch } from '@/lib/ref-tag';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const LABELS = { yes: 'YES', no: 'NO' };

function pool(over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id: 88n,
    creator: '0x00000000000000000000000000000000000000c1',
    mType: MarketType.CRYPTO,
    oracleRef: '0x4254433a67743a31000000000000000000000000000000000000000000000000', // BTC:gt:1, a reference the resolver reads
    question: 'Will BTC close above $80,000 in 1 day?',
    createdAt: BigInt(NOW - 3_600),
    bettingCloseTime: BigInt(NOW + 6 * 3_600 + 11 * 60),
    closeTime: BigInt(NOW + 8 * 3_600),
    totalYes: 30n * USDC,
    totalNo: 10n * USDC,
    yesBettorCount: 2,
    noBettorCount: 1,
    outcome: Outcome.UNRESOLVED,
    resolved: false,
    creatorFeeClaimed: false,
    protocolFeeBpsSnapshot: 100,
    creatorFeeBpsSnapshot: 200,
    ...over,
  };
}

describe('the shared link', () => {
  const targets: ShareTarget[] = ['x', 'whatsapp', 'telegram', 'link'];

  it.each(targets)('points %s at the pool on production, tagged with its target and the pool campaign', (t) => {
    const url = new URL(poolInviteLink(88n, t));
    expect(url.origin).toBe('https://makomarket.xyz');
    expect(url.pathname).toBe('/pools/88');
    expect(url.searchParams.get('utm_source')).toBe(t);
    expect(url.searchParams.get('utm_campaign')).toBe('pool-88');
    expect([...url.searchParams.keys()]).toEqual(['utm_source', 'utm_campaign']);
  });

  it('is the exact string the brief names', () => {
    expect(poolInviteLink(88n, 'whatsapp')).toBe('https://makomarket.xyz/pools/88?utm_source=whatsapp&utm_campaign=pool-88');
    expect(SHARE_ORIGIN).toBe('https://makomarket.xyz');
  });

  it('carries a campaign the ref capture keeps, up to the longest pool id the page accepts (18 digits)', () => {
    for (const id of [0n, 7n, 123_456_789_012_345_678n]) {
      const url = new URL(poolInviteLink(id, 'x'));
      expect(refFromSearch(url.search)).toBe(`pool-${id}`);
    }
  });

  it('drops a campaign the ref rule would refuse instead of sending one', () => {
    const id = 10n ** 30n; // "pool-" + 31 digits = 36 characters, over the rule's 32
    const url = new URL(poolInviteLink(id, 'link'));
    expect(url.searchParams.get('utm_campaign')).toBeNull();
    expect(url.searchParams.get('utm_source')).toBe('link');
  });

  it('prints without the scheme', () => {
    expect(linkDisplay(poolInviteLink(88n, 'link'))).toBe('makomarket.xyz/pools/88?utm_source=link&utm_campaign=pool-88');
  });
});

describe('share-intent URLs', () => {
  // Every character that would break a query string if it were not encoded.
  const NASTY = 'Will "A&B" hit 100% #1? a+b=c / 50/50 🦈\nnext line';

  it('X opens the official post intent with the text and the link as separate, encoded values', () => {
    const raw = intentUrl('x', 88n, NASTY);
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe('https://x.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe(`${NASTY} on Mako Market`);
    expect(url.searchParams.get('url')).toBe(poolInviteLink(88n, 'x'));
    expect([...url.searchParams.keys()]).toEqual(['text', 'url']);
    expect(raw).not.toMatch(/[ \n"#]/);
    expect(raw).not.toContain('+');
  });

  it('WhatsApp puts the text and the link in its one text value', () => {
    const raw = intentUrl('whatsapp', 88n, NASTY);
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe('https://wa.me/');
    expect(url.searchParams.get('text')).toBe(`${NASTY} on Mako Market ${poolInviteLink(88n, 'whatsapp')}`);
    expect([...url.searchParams.keys()]).toEqual(['text']);
    expect(raw).not.toMatch(/[ \n"#+]/);
  });

  it('Telegram opens the official share link with the link and the text', () => {
    const raw = intentUrl('telegram', 88n, NASTY);
    const url = new URL(raw);
    expect(`${url.origin}${url.pathname}`).toBe('https://t.me/share/url');
    expect(url.searchParams.get('url')).toBe(poolInviteLink(88n, 'telegram'));
    expect(url.searchParams.get('text')).toBe(`${NASTY} on Mako Market`);
    expect([...url.searchParams.keys()]).toEqual(['url', 'text']);
    expect(raw).not.toMatch(/[ \n"#+]/);
  });

  it('encodes spaces as %20, which every target reads as a space', () => {
    expect(intentUrl('x', 88n, 'Will it rain')).toContain('text=Will%20it%20rain%20on%20Mako%20Market');
  });

  it('says "<question> on Mako Market"', () => {
    expect(shareText('Will BTC close above $80,000 in 1 day?')).toBe('Will BTC close above $80,000 in 1 day? on Mako Market');
  });
});

describe('the card', () => {
  it('quotes the pool page helper multipliers, amounts and bettor counts', () => {
    const m = pool();
    const row = poolRow(m, NOW);
    const card = poolInviteCard(m, NOW, LABELS);
    expect(card.sides[0].pays).toBe(formatPays(row.yesPays));
    expect(card.sides[1].pays).toBe(formatPays(row.noPays));
    // Independent check: 40 USDC less 3% fees = 38.8 to winners; YES 38.8 / 30, NO 38.8 / 10.
    expect(card.sides[0].pays).toBe('1.29x');
    expect(card.sides[1].pays).toBe('3.88x');
    expect(card.sides[0]).toMatchObject({ name: 'YES', amount: '30.00', bettors: 2 });
    expect(card.sides[1]).toMatchObject({ name: 'NO', amount: '10.00', bettors: 1 });
  });

  it('cannot quote a side with no stake (the page says "No stake yet")', () => {
    const card = poolInviteCard(pool({ totalNo: 0n, noBettorCount: 0 }), NOW, LABELS);
    expect(card.sides[0].pays).toBe('1.00x');
    expect(card.sides[1].pays).toBeNull();
  });

  it('uses the side names it is given (a house pool can name its own)', () => {
    const card = poolInviteCard(pool({ mType: MarketType.MAKO }), NOW, { yes: 'Tinubu', no: 'Obi' });
    expect(card.sides.map((s) => s.name)).toEqual(['Tinubu', 'Obi']);
    expect(card.sub).toBe('Bet Tinubu or Obi · settled by Mako Market');
  });

  it('while open, asks for a bet: open pill, countdown, Scan to join, the minimum', () => {
    const m = pool();
    const card = poolInviteCard(m, NOW, LABELS);
    expect(card.open).toBe(true);
    expect(card.pill).toEqual({ label: 'OPEN', colour: 'var(--mako-signal)' });
    expect(card.clock).toEqual({ label: 'Closes in', value: '6H 11M' });
    expect(card.scanTitle).toBe('Scan to join');
    expect(card.minLine).toBe('Min 0.10 USDC · gas-free with email');
    expect(card.cat).toBe('CRYPTO');
  });

  const closed: [string, Partial<MarketWithId>, string, string][] = [
    ['betting closed', { bettingCloseTime: BigInt(NOW - 60), closeTime: BigInt(NOW + 3_600) }, 'BETTING CLOSED', 'var(--mako-gold)'],
    ['resolving', { bettingCloseTime: BigInt(NOW - 7_200), closeTime: BigInt(NOW - 60) }, 'RESOLVING', 'var(--mako-violet)'],
    ['YES won', { bettingCloseTime: BigInt(NOW - 7_200), closeTime: BigInt(NOW - 60), resolved: true, outcome: Outcome.YES }, 'YES WON', 'var(--mako-teal)'],
    ['NO won', { bettingCloseTime: BigInt(NOW - 7_200), closeTime: BigInt(NOW - 60), resolved: true, outcome: Outcome.NO }, 'NO WON', 'var(--mako-red)'],
    ['refunded', { bettingCloseTime: BigInt(NOW - 7_200), closeTime: BigInt(NOW - 60), resolved: true, outcome: Outcome.REFUND }, 'REFUNDED', 'var(--mako-cyan)'],
  ];

  it.each(closed)('once %s, shows the state and no call to bet', (_, over, label, colour) => {
    const m = pool(over);
    const card = poolInviteCard(m, NOW, LABELS);
    const clock = poolClock(m, card.state, NOW);
    expect(card.open).toBe(false);
    expect(card.pill).toEqual({ label, colour });
    expect(card.sub).toBe(clock.sub);
    expect(card.sub).not.toMatch(/^Bet /);
    expect(card.clock).toEqual({ label: clock.label, value: clock.value });
    expect(card.scanTitle).toBe('Scan to view');
    expect(card.minLine).toBeNull();
  });
});
