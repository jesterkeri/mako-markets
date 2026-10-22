// Motion pass 1 (Joshua 2026-10-16): the confirm sheet's step body is keyed on the step, so a new step mounts fresh
// and plays its entrance (opacity + 6px rise, 200 ms ease-out) instead of swapping in place; a check that replaces a
// spinner scales in from 0.8 (150 ms). The first step arrives with the sheet's own entrance, so it gets no second one.
// Reduced motion: opacity only, 150 ms.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { ConfirmSheet, type ConfirmPhase, type ConfirmSpec } from '@/components/ConfirmSheet';
import { durations, inReducedMotion, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const SPEC: ConfirmSpec = {
  glyph: 'Y',
  glyphColor: 'var(--mako-yes)',
  title: 'Bet YES · 5.00 USDC',
  confirmLabel: 'Confirm · 5.00 USDC',
  pendingTitle: 'Placing your bet',
  rows: [{ label: 'Stake', value: '5.00 USDC' }],
  note: 'Payout is an estimate until betting closes.',
  doneTitle: 'Bet placed',
  doneBody: '5.00 USDC on YES.',
};
const WALLET = { kind: 'mako' as const, address: '0xC8BF000000000000000000000000000000090F1a' };
const handlers = () => ({ onConfirm: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() });

function sheet(phase: ConfirmPhase, h = handlers()) {
  return <ConfirmSheet spec={SPEC} phase={phase} wallet={WALLET} {...h} />;
}
/// The desktop dialog's step body (the mobile one is the same tree).
const stepBody = () => screen.getAllByRole('dialog')[0].querySelector<HTMLElement>('[data-step-body]')!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('confirm sheet: one entrance per step', () => {
  it('the first step has no entrance of its own (the sheet already enters)', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    render(sheet({ step: 'review' }));
    expect(stepBody()).not.toBeNull();
    expect(stepBody().classList.contains('mk-stepin')).toBe(false);
  });

  it('each new step mounts a fresh body that carries the entrance', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const h = handlers();
    const view = render(sheet({ step: 'review' }, h));
    const review = stepBody();

    view.rerender(sheet({ step: 'pending', stage: 'signing' }, h));
    const pending = stepBody();
    expect(pending).not.toBe(review);
    expect(review.isConnected).toBe(false);
    expect(pending.classList.contains('mk-stepin')).toBe(true);

    // A stage inside the same step is not a new step: same node, no replay.
    view.rerender(sheet({ step: 'pending', stage: 'sending' }, h));
    expect(stepBody()).toBe(pending);

    view.rerender(sheet({ step: 'done' }, h));
    const done = stepBody();
    expect(done).not.toBe(pending);
    expect(done.classList.contains('mk-stepin')).toBe(true);
    expect(screen.getAllByText('Bet placed').length).toBeGreaterThan(0);
  });

  it('a stage check that replaces the spinner, and the done check, scale in', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const h = handlers();
    const view = render(sheet({ step: 'pending', stage: 'signing' }, h));
    expect(stepBody().querySelectorAll('.mk-checkin')).toHaveLength(0);
    view.rerender(sheet({ step: 'pending', stage: 'sending' }, h));
    // "Signed" is done now; its check enters.
    expect(stepBody().querySelectorAll('.mk-checkin')).toHaveLength(1);
    expect(stepBody().querySelector('.mk-checkin svg')).not.toBeNull();
    view.rerender(sheet({ step: 'done' }, h));
    expect(stepBody().querySelectorAll('.mk-checkin')).toHaveLength(1);
  });

  it('keyboard focus still lands on the main action of the new step', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const h = handlers();
    const view = render(sheet({ step: 'pending', stage: 'confirming' }, h));
    view.rerender(sheet({ step: 'done' }, h));
    expect(document.activeElement?.textContent).toBe('Done');
  });
});

describe('confirm sheet: the shipped CSS', () => {
  it('the step entrance is opacity + translateY(6px), 200 ms, ease-out', () => {
    const [anim] = rulesFor(SHELL, '.mk-stepin', 'top');
    expect(anim.decls.get('animation')).toMatch(/^mkStepIn 200ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both$/);
    const from = rulesFor(SHELL, 'from', (c) => c.includes('@keyframes mkStepIn'))[0];
    expect(from.decls.get('opacity')).toBe('0');
    expect(from.decls.get('transform')).toBe('translateY(6px)');
  });

  it('the check enters from scale(0.8), 150 ms, ease-out', () => {
    const [anim] = rulesFor(SHELL, '.mk-checkin', 'top');
    expect(anim.decls.get('animation')).toMatch(/^mkCheckIn 150ms cubic-bezier\(0\.23, 1, 0\.32, 1\) both$/);
    const from = rulesFor(SHELL, 'from', (c) => c.includes('@keyframes mkCheckIn'))[0];
    expect(from.decls.get('opacity')).toBe('0');
    expect(from.decls.get('transform')).toBe('scale(0.8)');
  });

  it('reduced motion: both become a 150 ms fade, no movement', () => {
    for (const sel of ['.mk-stepin', '.mk-checkin']) {
      const reduced = rulesFor(SHELL, sel, inReducedMotion);
      expect(reduced, sel).toHaveLength(1);
      const value = reduced[0].decls.get('animation')!;
      expect(value).toMatch(/^mkFade /);
      expect(durations(value)).toEqual([150]);
    }
    const fade = rulesFor(SHELL, 'from', (c) => c.includes('@keyframes mkFade'))[0];
    expect([...fade.decls.keys()]).toEqual(['opacity']);
  });
});
