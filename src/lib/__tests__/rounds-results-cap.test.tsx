// @vitest-environment jsdom
// Rounds' Results section (Joshua, 2026-10-15: old results crowded the page): only the latest RESULTS_SHOWN settled
// or refunded rounds, newest first, with a "See all results" link to /rounds?results=all that lists every one, on
// desktop and mobile. Rounds above Results are untouched. And hiding results removes no way to claim: the Rounds list
// has no claim control of its own (a row is a link to its round's page, which still works), and every claimable round
// hidden here is in Me's "Ready to claim" (meRoundPositions + meRoundTotals, the functions Me's claims are built from).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, className, style }: { href: string; children: React.ReactNode; className?: string; style?: React.CSSProperties }) => (
    <a href={href} className={className} style={style}>
      {children}
    </a>
  ),
}));

import { meRoundPositions, meRoundTotals, type RoundStakeRead } from '@/lib/me-rounds';
import { RefundReason, RoundOutcome, RoundStatus, settledPayout, type Round } from '@/lib/rounds-model';
import { ALL_RESULTS_HREF, RESULTS_SHOWN, RoundSections } from '@/app/rounds/RoundsClient';

const USDC = 1_000_000n;
const NOW = 1_800_000_000;
const HOUSE = '0x00000000000000000000000000000000000000c2' as const;
const ME = '0x00000000000000000000000000000000000000a5' as const;

function round(id: number, startTime: number, over: Partial<Round> = {}): Round {
  return {
    id: BigInt(id),
    creator: HOUSE,
    openTime: startTime - 3_600,
    startTime,
    status: RoundStatus.Settled,
    outcome: RoundOutcome.Up,
    refundReason: RefundReason.None,
    anchorPrice: 60_000n * 10n ** 18n,
    closePrice: 60_001n * 10n ** 18n,
    upPool: 2n * USDC,
    downPool: 1n * USDC,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 30_000n,
    creatorFee: 20_000n,
    distributable: 2_950_000n,
    ...over,
  };
}

// Six results, ids 1..6, started an hour apart (6 newest), refunds at 2 and 5; plus one round open for predictions and
// one waiting for its result (one-sided, so it will refund once someone marks it).
const RESULTS = [1, 2, 3, 4, 5, 6].map((id) =>
  round(id, NOW - (10 - id) * 3_600, id === 2 || id === 5 ? { status: RoundStatus.Refunded, outcome: RoundOutcome.None, refundReason: RefundReason.OneSided } : {}),
);
const OPEN = round(8, NOW + 3_600, { status: RoundStatus.Active, outcome: RoundOutcome.None, protocolFee: 0n, creatorFee: 0n, distributable: 0n });
const WAITING = round(7, NOW - 2 * 3_600, { status: RoundStatus.Active, outcome: RoundOutcome.None, downPool: 0n, downEntrants: 0, protocolFee: 0n, creatorFee: 0n, distributable: 0n });
const ROUNDS = [...RESULTS, OPEN, WAITING];

afterEach(cleanup);

const section = (root: HTMLElement, name: string) => within(root).getByRole('region', { name });
const roundLinks = (el: HTMLElement) => Array.from(el.querySelectorAll('a[href^="/rounds/"]')).map((a) => a.getAttribute('href'));

for (const narrow of [false, true]) {
  describe(`Results on the ${narrow ? 'mobile' : 'desktop'} layout`, () => {
    it(`shows the latest ${RESULTS_SHOWN} results, newest first, and links to all of them`, () => {
      const { container } = render(<RoundSections rounds={ROUNDS} now={NOW} narrow={narrow} />);
      const results = section(container, 'Results');
      expect(roundLinks(results)).toEqual(['/rounds/6', '/rounds/5', '/rounds/4']);
      expect(results.textContent).toContain(`Results · 6 · latest ${RESULTS_SHOWN} by start time`);
      const seeAll = within(results).getByRole('link', { name: 'See all results (6)' });
      expect(seeAll.getAttribute('href')).toBe(ALL_RESULTS_HREF);
      expect(ALL_RESULTS_HREF).toBe('/rounds?results=all');
    });

    it('orders by scheduled start (the contract records no end time): a late refund of an earlier round stays under See all, and says so', () => {
      // Round 3 started before 4, 5 and 6 but was refunded only at its no-price deadline, after they settled: it is the
      // newest END, yet the capped list is the latest three STARTS, and the heading says that is the rule.
      const late = RESULTS.map((r) => (r.id === 3n ? { ...r, status: RoundStatus.Refunded, outcome: RoundOutcome.None, refundReason: RefundReason.NoPrice } : r));
      const { container } = render(<RoundSections rounds={[...late, OPEN, WAITING]} now={NOW} narrow={narrow} />);
      const results = section(container, 'Results');
      expect(roundLinks(results)).toEqual(['/rounds/6', '/rounds/5', '/rounds/4']);
      expect(results.textContent).toContain('by start time');
      const all = render(<RoundSections rounds={[...late, OPEN, WAITING]} now={NOW} narrow={narrow} allResults />);
      expect(roundLinks(section(all.container, 'Results'))).toContain('/rounds/3');
    });

    it('a one-sided round refunded just before its start sorts by that start (first), as the rule says', () => {
      const early = round(9, NOW + 30, { status: RoundStatus.Refunded, outcome: RoundOutcome.None, refundReason: RefundReason.OneSided, downPool: 0n, downEntrants: 0 });
      const { container } = render(<RoundSections rounds={[...ROUNDS, early]} now={NOW} narrow={narrow} />);
      expect(roundLinks(section(container, 'Results'))).toEqual(['/rounds/9', '/rounds/6', '/rounds/5']);
    });

    it('lists every result with ?results=all, with a way back to the latest few', () => {
      const { container } = render(<RoundSections rounds={ROUNDS} now={NOW} narrow={narrow} allResults />);
      const results = section(container, 'Results');
      expect(roundLinks(results)).toEqual(['/rounds/6', '/rounds/5', '/rounds/4', '/rounds/3', '/rounds/2', '/rounds/1']);
      expect(within(results).getByRole('link', { name: `Show the latest ${RESULTS_SHOWN} only` }).getAttribute('href')).toBe('/rounds');
    });

    it('leaves the rounds above Results as they were', () => {
      const { container } = render(<RoundSections rounds={ROUNDS} now={NOW} narrow={narrow} />);
      expect(roundLinks(section(container, 'Open for predictions'))).toEqual(['/rounds/8']);
      expect(roundLinks(section(container, 'Waiting for the result'))).toEqual(['/rounds/7']);
    });

    it(`shows no control when there are ${RESULTS_SHOWN} results or fewer`, () => {
      const { container } = render(<RoundSections rounds={[...RESULTS.slice(3), OPEN]} now={NOW} narrow={narrow} />);
      const results = section(container, 'Results');
      expect(roundLinks(results)).toEqual(['/rounds/6', '/rounds/5', '/rounds/4']);
      expect(within(results).queryByRole('link', { name: /see all|latest/i })).toBeNull();
    });

    it('has no claim control of its own: the only actions are links to round pages and the results link', () => {
      for (const allResults of [false, true]) {
        const { container, unmount } = render(<RoundSections rounds={ROUNDS} now={NOW} narrow={narrow} allResults={allResults} />);
        expect(container.querySelectorAll('button')).toHaveLength(0);
        expect(container.textContent).not.toMatch(/claim/i);
        const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
        expect(hrefs.every((h) => /^\/rounds\/\d+$/.test(h ?? '') || h === ALL_RESULTS_HREF || h === '/rounds')).toBe(true);
        unmount();
      }
    });
  });
}

describe('hiding older results removes no claim path: Me lists every claimable round', () => {
  // This account: an unclaimed win on round 1, a marked refund on round 2 and an already claimed win on round 3 (all
  // hidden from Rounds), a loss on round 4 and an unclaimed win on round 6 (shown). Round 1 is also its own hosted
  // round with the host fee unclaimed, which `claim` pays too.
  const mine = RESULTS.map((r) => (r.id === 1n ? { ...r, creator: ME } : r));
  const stakes = new Map<string, RoundStakeRead>([
    ['1', { stake: { side: 'up', amount: 2n * USDC }, claimed: false, creatorFeeClaimed: false }],
    ['2', { stake: { side: 'down', amount: 1n * USDC }, claimed: false, creatorFeeClaimed: false }],
    ['3', { stake: { side: 'up', amount: 2n * USDC }, claimed: true, creatorFeeClaimed: false }],
    ['4', { stake: { side: 'down', amount: 1n * USDC }, claimed: false, creatorFeeClaimed: false }],
    ['6', { stake: { side: 'up', amount: 2n * USDC }, claimed: false, creatorFeeClaimed: false }],
  ]);

  it('every claimable round, shown on Rounds or not, is in Me with what claim() pays', () => {
    const { container } = render(<RoundSections rounds={mine} now={NOW} narrow={false} />);
    const shown = new Set(roundLinks(section(container, 'Results')).map((h) => h!.split('/').pop()));
    const hidden = mine.filter((r) => !shown.has(r.id.toString())).map((r) => r.id.toString());
    expect(hidden).toEqual(['1', '2', '3']);

    const claims = meRoundTotals(meRoundPositions(mine, stakes, ME, NOW)).claims;
    expect(claims.map((c) => [c.round.id.toString(), c.claim])).toEqual([
      ['6', settledPayout(mine[5], 2n * USDC)],
      ['2', 1n * USDC],
      ['1', settledPayout(mine[0], 2n * USDC) + mine[0].creatorFee],
    ]);
    // The hidden rounds with something to claim (1 and 2) are all there; 3 is already claimed, 4 was lost.
    const inMe = new Set(claims.map((c) => c.round.id.toString()));
    for (const id of ['1', '2']) expect(inMe.has(id)).toBe(true);
  });

  it('a host fee alone, on a hidden round with no stake, is in Me too', () => {
    const hosted = RESULTS.map((r) => (r.id === 3n ? { ...r, creator: ME } : r));
    const onlyFee = new Map<string, RoundStakeRead>([['3', { stake: { side: null, amount: 0n }, claimed: false, creatorFeeClaimed: false }]]);
    const claims = meRoundTotals(meRoundPositions(hosted, onlyFee, ME, NOW)).claims;
    expect(claims.map((c) => [c.round.id.toString(), c.claim])).toEqual([['3', hosted[2].creatorFee]]);
  });
});

describe('/rounds?results=all reaches the full history', () => {
  it('the page passes allResults only for results=all', async () => {
    const { default: RoundsPage } = await import('@/app/rounds/page');
    const props = async (q: Record<string, string | string[]>) => ((await RoundsPage({ searchParams: Promise.resolve(q) })) as React.ReactElement<{ allResults: boolean }>).props;
    expect((await props({ results: 'all' })).allResults).toBe(true);
    expect((await props({})).allResults).toBe(false);
    expect((await props({ results: 'ALL' })).allResults).toBe(false);
    expect((await props({ results: ['all', 'all'] })).allResults).toBe(false);
  });
});
