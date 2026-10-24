// Adversary pass on c018262: the placed-bet done tile is black in every sheet, the Mako mark is decoration only,
// and every other done tile is unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';

import { ConfirmSheet, type ConfirmSpec } from '@/components/ConfirmSheet';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

const BASE: ConfirmSpec = {
  glyph: 'N',
  glyphColor: 'var(--mako-no)',
  title: 'Bet Lakers · 10.00 USDC',
  confirmLabel: 'Confirm · 10.00 USDC',
  pendingTitle: 'Placing your bet',
  rows: [{ label: 'Pool', value: 'Lakers vs Celtics' }],
  note: 'Payout is an estimate until betting closes.',
  doneTitle: 'Bet placed',
  doneBody: '10.00 USDC on Los Angeles Lakers.',
};
const WALLET = { kind: 'mako' as const, address: '0xC8BF000000000000000000000000000000090F1a' };
const TX = `0x${'71c3'.padEnd(64, 'a')}`;
const handlers = () => ({ onConfirm: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mountSide(name: string) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const spec: ConfirmSpec = { ...BASE, doneSide: { name, amount: '10.00 USDC' } };
  render(<ConfirmSheet spec={spec} phase={{ step: 'done', txHash: TX }} wallet={WALLET} {...handlers()} doneExtra={<button type="button">Share your call</button>} />);
}

describe('adversary c018262: black bet tile', () => {
  it('both the desktop dialog and the phone sheet tile are black, for a long team name too', () => {
    mountSide('Los Angeles Lakers');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThanOrEqual(2);
    for (const s of statuses) {
      const tile = s.parentElement as HTMLElement;
      expect(tile.style.background).toBe('#000');
      expect(tile.style.color).toBe('var(--mako-paper)');
      // The mark is not part of what a screen reader announces as the status, and holds no text.
      expect(s.textContent).toBe('Bet placedLos Angeles Lakers10.00 USDC');
      const mark = tile.querySelector(':scope > span[aria-hidden="true"]') as HTMLElement;
      expect(mark).not.toBeNull();
      expect(s.contains(mark)).toBe(false);
      expect(mark.querySelector('svg')).not.toBeNull();
      expect(mark.textContent).toBe('');
      expect(mark.querySelector('title')).toBeNull();
      // Decoration: no hit area, behind the text inside the tile's own stacking context.
      expect(mark.style.pointerEvents).toBe('none');
      expect(mark.style.position).toBe('absolute');
      expect(Number(mark.style.zIndex)).toBeLessThan(0);
      expect(tile.style.isolation).toBe('isolate');
      // The link and Share stay inside the same tile and are not descendants of the mark.
      const link = within(tile).getByText(/Transaction ·/).closest('a') as HTMLElement;
      const share = within(tile).getByText('Share your call');
      expect(mark.contains(link)).toBe(false);
      expect(mark.contains(share)).toBe(false);
    }
  });

  it('no shell CSS rule repaints the done tile (dark yellow phone sheet included)', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/mako-shell.css'), 'utf8');
    const tileRules = css.match(/[^{}]*\.wl-tile[^{}]*\{[^}]*\}/g) ?? [];
    for (const r of tileRules) {
      expect(r).not.toMatch(/background|(^|[^-])color\s*:/);
    }
  });

  it('every other done tile keeps its old look and has no mark', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    render(<ConfirmSheet spec={{ ...BASE, doneTitle: 'Claimed', doneBody: '5.00 USDC is in your balance.' }} phase={{ step: 'done', txHash: TX }} wallet={WALLET} {...handlers()} />);
    for (const s of screen.getAllByRole('status')) {
      const tile = s.parentElement as HTMLElement;
      expect(tile.getAttribute('style')).toBe(
        'border-radius: 28px; background: var(--m3-inv); color: var(--m3-inv-fg); box-shadow: var(--edge); padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 12px;',
      );
      expect(tile.querySelector(':scope > span[aria-hidden="true"]')).toBeNull();
    }
  });

  it('the placed-bet copy has no em dash', () => {
    mountSide('NO');
    expect(document.body.textContent ?? '').not.toContain('—');
  });
});
