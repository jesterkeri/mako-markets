'use client';

import { ConfirmSheet, type ConfirmPhase, type ConfirmSpec } from '@/components/ConfirmSheet';

// Dev-only: the confirm sheet in each state with sample copy, for comparing against the design. Never reachable
// in production (the page 404s unless MAKO_STAGE=dev).
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
    { label: 'Est. payout if NO wins', value: '19.20 USDC' },
  ],
  note: 'Payout is an estimate until betting closes at kick-off.',
  doneTitle: 'Bet placed',
  doneBody: '10.00 USDC on NO.',
  doneSecondary: { label: 'View in Me', href: '/me' },
};
const TX = `0x71c3${'0'.repeat(56)}b8e0`;
const PHASES: Record<string, ConfirmPhase> = {
  review: { step: 'review' },
  pending: { step: 'pending', stage: 'confirming', txHash: TX },
  done: { step: 'done', txHash: TX },
  cancelled: { step: 'cancelled' },
  failed: { step: 'failed', title: 'Betting closed first', body: 'The pool closed at kick-off before your bet reached Monad.', nothingMoved: true, primary: { label: 'Browse pools', href: '/pools' }, secondary: { label: 'Close' } },
};

export function Preview({ state, wallet }: { state: string; wallet: string }) {
  const noop = () => {};
  return (
    <ConfirmSheet
      spec={SPEC}
      phase={PHASES[state] ?? PHASES.review}
      wallet={{ kind: wallet === 'external' ? 'external' : 'mako', address: '0xC8BF00000000000000000000000000000000090F1' }}
      onConfirm={noop}
      onCancel={noop}
      onRetry={noop}
      onClose={noop}
    />
  );
}
