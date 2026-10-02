// Adversary pass on b4f4a5d. Spec under test:
//  1. A pool whose reference the resolver cannot read (`unsettleable`) never claims it will be settled, open,
//     closed or past close, and every place that says how its result is decided agrees with "How results work".
//  2. MarketCard money figures are exact (bigint), matching an exact reference at any size.
//  3. Home shows "No bets" for an empty pool side.
// Pools are built with viem's stringToHex, the same encoder the parity test uses.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as React from 'react';
import { stringToHex } from 'viem';

import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { poolClock, poolRules, resultSteps, unsettleable } from '@/lib/pool-rules';
import { poolInviteCard } from '@/lib/pool-invite';
import { poolRow } from '@/lib/pool-list';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

afterEach(cleanup);

const NOW = 1_800_000_000;
const pool = (ref: string, over: Partial<MarketWithId> = {}): MarketWithId => ({
  id: 9n,
  creator: '0x00000000000000000000000000000000000000c1',
  mType: MarketType.STOCKS,
  oracleRef: stringToHex(ref, { size: 32 }),
  question: 'Q?',
  createdAt: BigInt(NOW - 3 * 3600),
  closeTime: BigInt(NOW + 7200),
  bettingCloseTime: BigInt(NOW + 3600),
  totalYes: 5_000_000n,
  totalNo: 3_000_000n,
  yesBettorCount: 1,
  noBettorCount: 1,
  outcome: Outcome.UNRESOLVED,
  resolved: false,
  creatorFeeClaimed: false,
  protocolFeeBpsSnapshot: 100,
  creatorFeeBpsSnapshot: 200,
  ...over,
});

// The resolver's parsePriceFeedOracleRef rejects an unknown symbol (cf-worker/src/index.ts:662).
const BAD = 'MADEUP:gt:1';

describe('an unreadable pool past its close time (spec 1)', () => {
  // One hour past close, inside the 24H grace: state "resolving".
  const closed = pool(BAD, { bettingCloseTime: BigInt(NOW - 7200), closeTime: BigInt(NOW - 3600) });

  it('the pool page header does not say Mako Market settles it, while step 02 says it is not settled automatically', () => {
    expect(unsettleable(closed)).toBe(true);
    expect(resultSteps(closed, 408, 'UTC')[1].title).toBe('Not settled automatically');
    const clock = poolClock(closed, poolRow(closed, NOW).state, NOW, 'UTC');
    expect(clock.sub).not.toMatch(/Mako Market settles it/);
    expect(clock.value).not.toBe('Settling');
  });

  it('the share card (which reuses the header line) does not say Mako Market settles it', () => {
    expect(poolInviteCard(closed, NOW, { yes: 'YES', no: 'NO' }).sub).not.toMatch(/Mako Market settles it/);
  });
});

describe('an unreadable pool before close (spec 1)', () => {
  it('the open share card does not say it is settled by Mako Market', () => {
    const open = pool(BAD);
    expect(unsettleable(open)).toBe(true);
    expect(poolInviteCard(open, NOW, { yes: 'YES', no: 'NO' }).sub).not.toMatch(/settled by Mako Market/);
  });

  it('the CLOSES rule line does not promise "The result is settled after"', () => {
    const lines = poolRules(pool(BAD), 'UTC');
    const closes = lines.find((l) => l.k === 'CLOSES');
    expect(closes?.v).not.toMatch(/The result is settled after/);
  });
});

/// Independent exact reference: base units -> "<int>.<2dp>" rounded half up, in bigint, no grouping.
function exact2(base: bigint): string {
  const cents = (base + 5_000n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

describe('MarketCard money (spec 2)', () => {
  async function card(totalYes: bigint, totalNo: bigint) {
    const { MarketCard } = await import('@/components/MarketCard');
    const m = pool('TSLA:gt:250', { mType: MarketType.CRYPTO, oracleRef: stringToHex('BTC:gt:1', { size: 32 }), totalYes, totalNo });
    const { container } = render(<MarketCard market={m} />);
    return (container.textContent ?? '').replace(/,/g, '');
  }

  it('prints each side stake exactly above 2^53 base units', async () => {
    const yes = 1_208_925_819_614_629_174_700_000n; // 1,208,925,819,614,629,174.70 USDC
    const text = await card(yes, 1_000_000n);
    expect(text).toContain(`${exact2(yes)} USDC · 1 BET`);
  });

  it('a side stake and the pool total agree on the same 1.005 USDC', async () => {
    const text = await card(1_005_000n, 0n);
    expect(text).toContain(`POOL · ${exact2(1_005_000n)} USDC`);
    expect(text).toContain(`${exact2(1_005_000n)} USDC · 1 BET`);
  });
});

describe('Home mobile pool card (spec 3)', () => {
  it('says "No bets" for a side with no stake', async () => {
    const { PoolMobileCard } = await import('@/components/pools/PoolMobileCard');
    const m = pool('BTC:gt:1', { mType: MarketType.CRYPTO, totalYes: 5_000_000n, totalNo: 0n });
    const { container } = render(<PoolMobileCard row={poolRow(m, NOW)} labels={{ yes: 'YES', no: 'NO' }} />);
    const noSide = container.querySelector('a[href$="?side=no"]');
    expect(noSide?.textContent).toContain('No bets');
  });
});
