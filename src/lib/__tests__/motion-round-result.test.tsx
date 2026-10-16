// @vitest-environment jsdom
// Motion pass 4 (Joshua 2026-10-16): a round's big result plays its reveal (scale 0.92 -> 1 + opacity, 300 ms
// ease-out) only when it changes from pending to UP or DOWN while the page is open, never on first load, and once.
// Reduced motion: opacity only. Renders the real RoundView; no chain is read.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/components/MarketChart', () => ({ MarketChart: () => null }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  usePublicClient: () => ({}),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }), accountAddress: () => null }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { positionOf, RefundReason, RoundOutcome, RoundStatus, type Round, type RoundPhase } from '@/lib/rounds-model';
import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';
import { inReducedMotion, rulesFor, SHELL } from './helpers/motion-css';

const base: Round = {
  id: 3n,
  creator: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  openTime: 1_000_000,
  startTime: 1_000_000 + 3_600,
  status: RoundStatus.Active,
  outcome: RoundOutcome.None,
  refundReason: RefundReason.None,
  anchorPrice: 60_000n * 10n ** 18n,
  closePrice: 0n,
  upPool: 3_000_000n,
  downPool: 1_000_000n,
  upEntrants: 1,
  downEntrants: 1,
  protocolFee: 0n,
  creatorFee: 0n,
  distributable: 0n,
};
const SETTLED_UP: Round = { ...base, status: RoundStatus.Settled, outcome: RoundOutcome.Up, closePrice: 60_001n * 10n ** 18n, protocolFee: 40_000n, distributable: 3_960_000n };
const SETTLED_DOWN: Round = { ...SETTLED_UP, outcome: RoundOutcome.Down, closePrice: 59_999n * 10n ** 18n };
const now = base.startTime + 2_000;

function view(round: Round, phase: RoundPhase): View {
  return {
    round,
    phase,
    now,
    position: positionOf(round, { side: null, amount: 0n }, false, now),
    signedIn: false,
    balance: null,
    side: 'up',
    sideLocked: false,
    setSide: () => {},
    amountText: '',
    setAmountText: () => {},
    amount: null,
    estimate: null,
    why: 'closed',
    openEnter: () => {},
    claimAmount: 0n,
    creatorFeeDue: null,
    openClaim: () => {},
    refundToMark: RefundReason.None,
    openMarkRefund: () => {},
  };
}
const result = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-round-result]');

afterEach(cleanup);

describe('round result reveal', () => {
  it('a round already settled on first load shows its result still', () => {
    const { container } = render(<RoundView {...view(SETTLED_UP, 'settled')} narrow={false} />);
    expect(result(container)?.textContent).toBe('UP');
    expect(result(container)?.classList.contains('mk-resultin')).toBe(false);
  });

  for (const [round, word] of [
    [SETTLED_UP, 'UP'],
    [SETTLED_DOWN, 'DOWN'],
  ] as const)
    it(`pending -> ${word} while the page is open plays the reveal, once, on the same element`, () => {
      const v = render(<RoundView {...view(base, 'live')} narrow={false} />);
      expect(result(v.container)).toBeNull();
      v.rerender(<RoundView {...view(base, 'settling')} narrow={false} />);
      expect(v.container.querySelector('.mk-resultin')).toBeNull();
      v.rerender(<RoundView {...view(round, 'settled')} narrow={false} />);
      const el = result(v.container)!;
      expect(el.textContent).toBe(word);
      expect(el.classList.contains('mk-resultin')).toBe(true);
      // Later renders (the clock ticks every second) keep the same node, so the animation does not replay.
      v.rerender(<RoundView {...{ ...view(round, 'settled'), now: now + 1 }} narrow={false} />);
      expect(result(v.container)).toBe(el);
      expect(el.classList.contains('mk-resultin')).toBe(true);
    });

  it('a refund is not an UP/DOWN result: no reveal', () => {
    const refunded: Round = { ...base, status: RoundStatus.Refunded, refundReason: RefundReason.OneSided };
    const v = render(<RoundView {...view(base, 'settling')} narrow />);
    v.rerender(<RoundView {...view(refunded, 'refunded')} narrow />);
    expect(v.container.querySelector('.mk-resultin')).toBeNull();
  });

  it('the scale grows from the side the text sits on', () => {
    const desk = render(<RoundView {...view(SETTLED_UP, 'settled')} narrow={false} />);
    expect(result(desk.container)!.style.transformOrigin).toBe('right center');
    cleanup();
    const mob = render(<RoundView {...view(SETTLED_UP, 'settled')} narrow />);
    expect(result(mob.container)!.style.transformOrigin).toBe('left center');
  });
});

describe('round result reveal: the shipped CSS', () => {
  it('scale(0.92) -> 1 + opacity, 300 ms, ease-out', () => {
    const [rule] = rulesFor(SHELL, '.mk-resultin', 'top');
    expect(rule.decls.get('animation')).toBe('mkResultIn 300ms cubic-bezier(0.23, 1, 0.32, 1) both');
    const from = rulesFor(SHELL, 'from', (c) => c.includes('@keyframes mkResultIn'))[0];
    expect(from.decls.get('opacity')).toBe('0');
    expect(from.decls.get('transform')).toBe('scale(0.92)');
  });

  it('reduced motion: opacity only', () => {
    const [rule] = rulesFor(SHELL, '.mk-resultin', inReducedMotion);
    expect(rule.decls.get('animation')).toMatch(/^mkFade 300ms /);
  });
});
