// Confirm in wallet (19a): the sheet shows only what the real transaction is doing, and never claims more.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { ConfirmSheet, type ConfirmPhase, type ConfirmSpec } from '@/components/ConfirmSheet';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const SPEC: ConfirmSpec = {
  glyph: 'N',
  glyphColor: 'var(--mako-red)',
  title: 'Bet NO · 10.00 USDC',
  confirmLabel: 'Confirm · 10.00 USDC',
  pendingTitle: 'Placing your bet',
  rows: [
    { label: 'Pool', value: 'Will Arsenal beat Chelsea?' },
    { label: 'Side', value: 'NO', tone: 'no' },
    { label: 'Stake', value: '10.00 USDC' },
  ],
  note: 'Payout is an estimate until betting closes.',
  doneTitle: 'Bet placed',
  doneBody: '10.00 USDC on NO.',
};
const MAKO = { kind: 'mako' as const, address: '0xC8BF000000000000000000000000000000090F1a' };
const EXTERNAL = { kind: 'external' as const, address: '0x1111111111111111111111111111111111111111' };
const TX = `0x${'71c3'.padEnd(64, 'a')}`;

function mount(phase: ConfirmPhase, wallet: { kind: 'mako' | 'external'; address: string } = MAKO) {
  const handlers = { onConfirm: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  render(<ConfirmSheet spec={SPEC} phase={phase} wallet={wallet} {...handlers} />);
  return handlers;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConfirmSheet', () => {
  it('says gas is covered only for the Mako wallet', () => {
    mount({ step: 'review' });
    expect(screen.getAllByText('Free · gas covered').length).toBeGreaterThan(0);
    expect(screen.queryByText('Paid in MON by your wallet')).toBeNull();
  });

  it('tells a wallet account it pays the network fee', () => {
    mount({ step: 'review' }, EXTERNAL);
    expect(screen.getAllByText('Paid in MON by your wallet').length).toBeGreaterThan(0);
    expect(screen.queryByText('Free · gas covered')).toBeNull();
    expect(screen.getAllByText(/Your wallet · 0x1111…1111/).length).toBeGreaterThan(0);
  });

  it('Confirm and Cancel call the flow', () => {
    const h = mount({ step: 'review' });
    fireEvent.click(screen.getAllByText('Confirm · 10.00 USDC')[0]);
    fireEvent.click(screen.getAllByText('Cancel')[0]);
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('while pending there is no close button and Escape does nothing', () => {
    const h = mount({ step: 'pending', stage: 'confirming', txHash: TX });
    expect(screen.queryAllByLabelText('Close')).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.getAllByText('0x71c3…aaaa').length).toBeGreaterThan(0);
  });

  it('outside pending, Escape closes', () => {
    const h = mount({ step: 'review' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('links the real transaction on the explorer once done', () => {
    mount({ step: 'done', txHash: TX });
    const link = screen.getAllByText(/Transaction · 0x71c3…aaaa/)[0].closest('a');
    expect(link?.getAttribute('href')).toBe(`https://testnet.monadvision.com/tx/${TX}`);
  });

  it('claims "No USDC left your wallet" only when the flow knows nothing moved', () => {
    const base = { step: 'failed' as const, title: 'Betting closed first', body: 'The pool closed before your bet reached Monad.', primary: { label: 'Browse pools', href: '/pools' }, secondary: { label: 'Close' } };
    mount({ ...base, nothingMoved: true });
    expect(screen.getAllByText('No USDC left your wallet').length).toBeGreaterThan(0);
    cleanup();
    mount({ ...base, nothingMoved: false });
    expect(screen.queryByText('No USDC left your wallet')).toBeNull();
  });

  it('cancelled says nothing was sent and offers Try again', () => {
    const h = mount({ step: 'cancelled' });
    expect(screen.getAllByText('Nothing was sent. Your balance hasn’t changed.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('Try again')[0]);
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });

  it('never promises a notification or speaks as "we"', () => {
    for (const phase of [{ step: 'review' }, { step: 'pending', stage: 'signing' }, { step: 'cancelled' }] as ConfirmPhase[]) {
      mount(phase);
      expect(document.body.textContent).not.toMatch(/\b(we|we’ll|we'll|our)\b/i);
      expect(document.body.textContent).not.toMatch(/tell you when/i);
      cleanup();
    }
  });
});
