// The pool page's creator-earnings card (src/components/CreatorEarnings.tsx) in each state, desktop and mobile:
// a Claim button only when the fee is claimable, never for a forfeited fee (the contract would pay 0), and the
// confirm sheet's words name the on-chain amount.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CreatorEarningsCard, creatorFeeConfirmSpec } from '@/components/CreatorEarnings';
import { MarketType, Outcome, type MarketWithId } from '@/lib/contract';
import { creatorEarningOf } from '@/lib/creator-earnings';

const USDC = 1_000_000n;
const TX = `0x${'ab'.repeat(32)}`;

function pool(over: Partial<MarketWithId> = {}): MarketWithId {
  return {
    id: 7n,
    creator: '0x00000000000000000000000000000000000000c1',
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

afterEach(cleanup);

const CASES = [
  { state: 'claimable', m: pool(), label: 'Ready to claim', amount: '0.80 USDC', text: /2% of the 40\.00 USDC pool, yours to claim/ },
  { state: 'claimed', m: pool({ creatorFeeClaimed: true }), label: 'Claimed', amount: '0.80 USDC', text: /0\.80 USDC claimed\. It is in your balance/ },
  { state: 'forfeited', m: pool({ totalYes: 10n * USDC, totalNo: 407_999n }), label: 'Forfeited', amount: null, text: /under 4\.08% of the larger \(10\.00 USDC\), so the 0\.208159 USDC creator share went to the winners/ },
  { state: 'refunded', m: pool({ outcome: Outcome.REFUND }), label: 'Refunded, no fee', amount: null, text: /refunded, so it pays no creator fee/ },
  { state: 'unresolved', m: pool({ resolved: false, outcome: Outcome.UNRESOLVED }), label: 'Not resolved yet', amount: null, text: /Not resolved yet\. Creator earnings can be claimed once/ },
] as const;

describe.each(['desktop', 'mobile'] as const)('CreatorEarningsCard (%s)', (variant) => {
  it.each(CASES)('$state', ({ state, m, label, amount, text }) => {
    const e = creatorEarningOf(m)!;
    expect(e.state).toBe(state);
    const onClaim = vi.fn();
    render(<CreatorEarningsCard earning={e} onClaim={onClaim} lastTx={undefined} variant={variant} />);
    expect(screen.getByRole('region', { name: 'Creator earnings' })).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    if (amount) expect(screen.getByText(amount)).toBeTruthy();
    else expect(screen.queryByText(/^\d[\d,]*\.\d+ USDC$/)).toBeNull();
    const button = screen.queryByRole('button', { name: /Claim creator earnings/ });
    if (state === 'claimable') {
      expect(button?.textContent).toBe('Claim creator earnings 0.80 USDC');
      fireEvent.click(button!);
      expect(onClaim).toHaveBeenCalledTimes(1);
    } else {
      expect(button).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
    }
  });

  it('a claim made from this page links its transaction', () => {
    render(<CreatorEarningsCard earning={creatorEarningOf(pool({ creatorFeeClaimed: true }))!} onClaim={vi.fn()} lastTx={TX} variant={variant} />);
    expect(screen.getByRole('link').getAttribute('href')).toContain(TX);
  });
});

describe('creatorFeeConfirmSpec', () => {
  it('names the on-chain fee, exactly', () => {
    const spec = creatorFeeConfirmSpec(creatorEarningOf(pool({ totalYes: 135_999n, totalNo: 3_333_333n, outcome: Outcome.NO }))!);
    expect(spec.title).toBe('Claim creator earnings · 0.069386 USDC');
    expect(spec.confirmLabel).toBe('Confirm · 0.069386 USDC');
    expect(spec.doneBody).toBe('0.069386 USDC is in your balance.');
    expect(spec.rows).toContainEqual({ label: 'Creator fee', value: '2% of 3.469332 USDC' });
    for (const s of [spec.title, spec.note, spec.pendingTitle, spec.doneTitle, ...spec.rows.map((r) => r.value)]) expect(s).not.toMatch(/—|\bwe\b|\bour\b|\bus\b/i);
  });
});
