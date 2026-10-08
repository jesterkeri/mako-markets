// @vitest-environment jsdom
// Adversary pass on 44aa10d (Rounds screens). Each test states the contract or requirement it holds the screens to.
// Contract: mako-contracts/src/MakoRoundsV1.sol (feat/t15-deploy-rounds). Rounds address is mocked; no chain is read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const APPROVE_HASH = `0x${'a1'.repeat(32)}` as const;
const ENTER_HASH = `0x${'b2'.repeat(32)}` as const;

const m = vi.hoisted(() => ({
  connected: undefined as string | undefined,
  user: null as unknown,
  asked: [] as { fn: string; from: string }[],
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
  writeContractAsync: vi.fn(),
}));

// The charts fetch their own data (tested in chart-components.test.tsx); this test is about the page around them.
vi.mock('@/components/charts/PriceCandles', () => ({ PriceCandles: () => null }));
vi.mock('@/components/charts/YesShareChart', () => ({ YesShareChart: () => null }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: m.connected }),
  usePublicClient: () => ({ readContract: m.readContract, simulateContract: m.simulateContract, waitForTransactionReceipt: m.waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync: m.writeContractAsync }),
}));
vi.mock('@/lib/hooks', () => ({ useEnsureMonadChain: () => async () => {} }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: m.user }), accountAddress: () => A }));
vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: '0x00000000000000000000000000000000000000f0' }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));

import { useRoundTx } from '@/lib/use-round-tx';
import { commentary, entryCloseOf, closeTimeOf, estimateEntry, feesOf, perOneUsdc, phaseAt, RefundReason, RoundOutcome, RoundStatus, settledPayout, submitDeadlineOf, positionOf, pendingRefund, type Round } from '@/lib/rounds-model';
import { parseAmount } from '@/lib/pool-bet-rules';
import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';

const walletUser = { authed: true, authType: 'wallet', walletAddress: A, displayName: null, avatarUrl: null, lastSignInAt: null };

const base: Round = {
  id: 3n,
  creator: B,
  openTime: 1_000_000,
  startTime: 1_000_000 + 3_600,
  status: RoundStatus.Active,
  outcome: RoundOutcome.None,
  refundReason: RefundReason.None,
  anchorPrice: 0n,
  closePrice: 0n,
  upPool: 5_000_000n,
  downPool: 5_000_000n,
  upEntrants: 1,
  downEntrants: 1,
  protocolFee: 0n,
  creatorFee: 0n,
  distributable: 0n,
};

describe('useRoundTx, wallet account: approval sent, then the wallet is switched before the prediction', () => {
  beforeEach(() => {
    m.user = walletUser;
    m.connected = A;
    m.asked = [];
    m.readContract.mockResolvedValue(0n); // allowance short: an approval goes out first
    m.simulateContract.mockResolvedValue({});
    m.writeContractAsync.mockImplementation(async (req: { functionName: string; account?: string }) => {
      m.asked.push({ fn: req.functionName, from: (req.account ?? m.connected) as string });
      return req.functionName === 'approve' ? APPROVE_HASH : ENTER_HASH;
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('requirement 4: the sheet never says nothing moved, without a word of it, once the approval went out', async () => {
    let releaseApproval: () => void = () => {};
    const approvalPending = new Promise<void>((seen) => {
      m.waitForTransactionReceipt.mockImplementation(({ hash }: { hash: string }) => {
        if (hash !== APPROVE_HASH) return Promise.resolve({ status: 'success', logs: [] });
        seen();
        return new Promise((done) => {
          releaseApproval = () => done({ status: 'success', logs: [] });
        });
      });
    });
    const { result, rerender } = renderHook(() => useRoundTx());
    act(() => result.current.open({ kind: 'enter', roundId: 3n, side: 'up', amount: 5_000_000n }));
    let running: Promise<void> = Promise.resolve();
    await act(async () => {
      running = result.current.confirm();
      await approvalPending;
    });
    m.connected = B; // switched while the approval confirms
    rerender();
    await act(async () => {
      releaseApproval();
      await running;
    });
    // Precondition: the approval really was sent from A, and the prediction was refused before B was asked.
    expect(m.asked).toEqual([{ fn: 'approve', from: A }]);
    const p = result.current.phase;
    expect(p.step).toBe('failed');
    if (p.step !== 'failed') return;
    const disclosesApproval = /approv/i.test(`${p.title} ${p.body}`);
    // Either the sheet does not claim nothing moved, or it says the approval went out. It does neither.
    expect(p.nothingMoved && !disclosesApproval, `sheet after a sent approval: ${JSON.stringify({ title: p.title, body: p.body, nothingMoved: p.nothingMoved })}`).toBe(false);
  });
});

describe('commentary against finalizeRefund / settle windows', () => {
  it('requirement 1/2: past the submit deadline a two-sided round can no longer settle, so the line must not say it waits to settle', () => {
    const now = submitDeadlineOf(base); // settle reverts SubmitWindowClosed from here; finalizeRefund(NoPrice) is open
    expect(pendingRefund(base, now)).toBe(RefundReason.NoPrice);
    expect(commentary(base, now)).not.toMatch(/Waiting for the two signed Chainlink prices to settle it/);
  });
});

describe('claim button amount against claim()', () => {
  it('requirement 3: the claim button never shows more USDC than claim pays (contract floors per winner)', () => {
    // Settled, UP won. Pools built with the contract's own fee rule: up 3.00, down 0.15, total 3.15,
    // protocol floor(3_150_000 * 100 / 10_000) = 31_500, creator floor(150_000 * 200 / 10_000) = 3_000,
    // distributable 3_115_500. One UP winner holding the whole UP pool: claim() pays
    // floor(3_000_000 * 3_115_500 / 3_000_000) = 3_115_500, i.e. 3.1155 USDC.
    const r: Round = {
      ...base,
      status: RoundStatus.Settled,
      outcome: RoundOutcome.Up,
      upPool: 3_000_000n,
      downPool: 150_000n,
      upEntrants: 1,
      downEntrants: 1,
      protocolFee: 31_500n,
      creatorFee: 3_000n,
      distributable: 3_115_500n,
      anchorPrice: 60_000n * 10n ** 18n,
      closePrice: 60_001n * 10n ** 18n,
    };
    const stake = { side: 'up' as const, amount: 3_000_000n };
    const paid = settledPayout(r, stake.amount); // exactly what claim() pays: (1_500_000 * 3_067_000) / 3_000_000
    expect(paid).toBe(3_115_500n);
    const now = r.startTime + 2_000;
    const position = positionOf(r, stake, false, now);
    const v: View = {
      round: r,
      phase: 'settled',
      now,
      position,
      signedIn: true,
      balance: 0n,
      side: 'up',
      sideLocked: true,
      setSide: () => {},
      amountText: '5',
      setAmountText: () => {},
      amount: 5_000_000n,
      estimate: null,
      why: 'closed',
      openEnter: () => {},
      claimAmount: paid,
      creatorFeeDue: null,
      openClaim: () => {},
      refundToMark: RefundReason.None,
      openMarkRefund: () => {},
    };
    const { container } = render(<RoundView {...v} narrow={false} />);
    const button = Array.from(container.querySelectorAll('button')).find((b) => /^Claim /.test(b.textContent ?? ''));
    expect(button).toBeDefined();
    const shown = /Claim ([\d,]+)\.(\d+) USDC/.exec(button!.textContent ?? '');
    expect(shown).not.toBeNull();
    const shownBase = BigInt(shown![1].replace(/,/g, '')) * 1_000_000n + BigInt((shown![2] + '000000').slice(0, 6));
    // The button may read "Claim 3.11 USDC" (floor) or the exact 3.1155; it must not read 3.12.
    expect(shownBase, `button reads "${button!.textContent}", claim() pays ${paid} base units`).toBeLessThanOrEqual(paid);
  });
});

// Attacks that did not break the model; kept as regression checks against the contract's own rules.
describe('model edges that hold (contract parity)', () => {
  const max = 2n ** 256n - 1n;
  it('phase boundaries match phaseOf to the second', () => {
    const ec = entryCloseOf(base);
    const ct = closeTimeOf(base);
    expect([phaseAt(base, ec - 1), phaseAt(base, ec), phaseAt(base, base.startTime), phaseAt(base, ct - 1), phaseAt(base, ct)]).toEqual(['open', 'starting', 'live', 'live', 'settling']);
  });
  it('refund eligibility matches finalizeRefund: OneSided from entry close, NoPrice from close + 24h', () => {
    const one = { ...base, downPool: 0n, downEntrants: 0 };
    expect(pendingRefund(one, entryCloseOf(one) - 1)).toBe(RefundReason.None);
    expect(pendingRefund(one, entryCloseOf(one))).toBe(RefundReason.OneSided);
    expect(pendingRefund(base, submitDeadlineOf(base) - 1)).toBe(RefundReason.None);
    expect(pendingRefund(base, submitDeadlineOf(base))).toBe(RefundReason.NoPrice);
    expect(positionOf(one, { side: 'up', amount: 5_000_000n }, false, entryCloseOf(one))).toMatchObject({ kind: 'refund', marked: false });
  });
  it('fees floor as the contract does, at 1 base unit and near uint256', () => {
    expect(feesOf(1n, 1n)).toEqual({ protocolFee: 0n, creatorFee: 0n, distributable: 2n });
    const big = max / 200n;
    const f = feesOf(big, big);
    expect(f.protocolFee).toBe((2n * big * 100n) / 10_000n);
    expect(f.creatorFee).toBe((big * 200n) / 10_000n);
  });
  it('odds are null for an empty side and the estimate includes the new stake', () => {
    expect(perOneUsdc(1_000_000n, 0n).down).toBeNull();
    expect(estimateEntry('down', 1_000_000n, 0n, 1_000_000n, 0n)).toBe((1_000_000n * feesOf(1_000_000n, 1_000_000n).distributable) / 1_000_000n);
  });
  it('amount parsing keeps 6 decimals and refuses a 7th', () => {
    expect(parseAmount('0.099999')).toBe(99_999n);
    expect(parseAmount('0.1000001')).toBeNull();
  });
});
