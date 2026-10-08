// @vitest-environment jsdom
// Codex RELEASE_R5 F1: the house account's own view of a settled round (a fee due, shown only to it) calls the fee the
// house fee, never a creator fee. Renders the host's page with and without a stake of its own and reads the whole
// visible text. Rounds address is mocked; no chain is read.

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const BETTOR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const HOUSE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

// The charts fetch their own data (tested in chart-components.test.tsx); this test is about the page around them.
vi.mock('@/components/charts/PriceCandles', () => ({ PriceCandles: () => null }));
vi.mock('@/components/charts/YesShareChart', () => ({ YesShareChart: () => null }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => BETTOR }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { positionOf, RefundReason, RoundOutcome, RoundStatus, settledPayout, type Round } from '@/lib/rounds-model';
import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';

describe('the house view of a settled round never says creator', () => {
  // Pools and fees built with the contract's own fee rule: protocol floor(3_150_000 * 100 / 10_000) = 31_500,
  // host fee floor(150_000 * 200 / 10_000) = 3_000.
  const r: Round = {
    id: 3n,
    creator: HOUSE,
    openTime: 1_000_000,
    startTime: 1_000_000 + 3_600,
    status: RoundStatus.Settled,
    outcome: RoundOutcome.Up,
    refundReason: RefundReason.None,
    anchorPrice: 60_000n * 10n ** 18n,
    closePrice: 60_001n * 10n ** 18n,
    upPool: 3_000_000n,
    downPool: 150_000n,
    upEntrants: 1,
    downEntrants: 1,
    protocolFee: 31_500n,
    creatorFee: 3_000n,
    distributable: 3_115_500n,
  };
  const now = r.startTime + 2_000;
  const view = (stake: { side: 'up'; amount: bigint } | null): View => ({
    round: r,
    phase: 'settled',
    now,
    position: positionOf(r, stake ?? { side: null, amount: 0n }, false, now),
    signedIn: true,
    balance: 0n,
    side: 'up',
    sideLocked: stake !== null,
    setSide: () => {},
    amountText: '',
    setAmountText: () => {},
    amount: null,
    estimate: null,
    why: 'closed',
    openEnter: () => {},
    claimAmount: (stake ? settledPayout(r, stake.amount) : 0n) + r.creatorFee,
    creatorFeeDue: r.creatorFee, // the host, fee not yet claimed
    openClaim: () => {},
    refundToMark: RefundReason.None,
    openMarkRefund: () => {},
  });

  for (const [name, stake] of [
    ['no stake of its own', null],
    ['a winning stake too', { side: 'up' as const, amount: 3_000_000n }],
  ] as const) {
    it(`the house with ${name}`, () => {
      const { container } = render(<RoundView {...view(stake)} narrow={false} />);
      const text = container.textContent ?? '';
      // Precondition: the fee readout rendered, so the assertion below reads the text it is about.
      expect(text).toMatch(/house fee/i);
      expect(text).toContain('0.003');
      const creatorWords = text.match(/.{0,60}creator.{0,20}/gi) ?? [];
      expect(creatorWords, `house view calling the fee a creator fee: ${JSON.stringify(creatorWords)}`).toEqual([]);
    });
  }
});
