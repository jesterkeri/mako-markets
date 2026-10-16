// Motion pass 9 (Joshua 2026-10-16): the shared spinner (wl-spin) turns once every 0.7 s, linear (was 0.9 s; a faster
// spinner reads as faster loading). Reduced motion: unchanged, no spin. It is the one spinner on both layouts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as React from 'react';

import { ConfirmSheet } from '@/components/ConfirmSheet';
import { durations, inReducedMotion, rulesFor, SHELL } from './helpers/motion-css';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('spinner', () => {
  it('0.7 s per turn, linear, forever', () => {
    const [rule] = rulesFor(SHELL, '.wl-spin', 'top');
    const a = rule.decls.get('animation')!;
    expect(a).toBe('wlSpin 0.7s linear infinite');
    expect(durations(a)).toEqual([700]);
  });

  it('reduced motion: no spin', () => {
    const [rule] = rulesFor(SHELL, '.wl-spin', inReducedMotion);
    expect(rule.decls.get('animation')).toBe('none');
  });

  it('the confirm sheet uses it on desktop and mobile', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    render(
      <ConfirmSheet
        spec={{ glyph: 'Y', glyphColor: 'var(--mako-yes)', title: 'Bet', confirmLabel: 'Confirm', pendingTitle: 'Placing your bet', rows: [], note: '', doneTitle: 'Done', doneBody: '' }}
        phase={{ step: 'pending', stage: 'signing' }}
        wallet={{ kind: 'mako', address: '0xC8BF000000000000000000000000000000090F1a' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const [desk, mob] = screen.getAllByRole('dialog');
    expect(desk.querySelectorAll('.wl-spin').length).toBeGreaterThan(0);
    expect(mob.querySelectorAll('.wl-spin').length).toBeGreaterThan(0);
  });
});
