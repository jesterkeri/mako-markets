// Focus in the redesign's dialogs follows the layout on screen (Codex S1 r2 MINOR): both the desktop dialog and the
// mobile sheet render and CSS shows one. When the window crosses 1024px while a dialog is open, Tab must stay in
// the one now visible and focus must move into it, without a detour to the opener; closing still returns focus to
// the opener.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: false }), useDisconnect: () => ({ disconnectAsync: vi.fn() }) }));
vi.mock('@/components/PrivyAuth', () => ({ useEmbeddedActions: () => ({ logout: vi.fn(), exportKey: vi.fn() }) }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ setQueryData: vi.fn() }) }));

import { ConfirmSheet } from '@/components/ConfirmSheet';
import { SignOutConfirm } from '@/components/shell/SignOutConfirm';

function fakeWidth(desktop: boolean) {
  const state = { matches: desktop };
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return state.matches;
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  vi.spyOn(window, 'matchMedia').mockImplementation(() => mql as unknown as MediaQueryList);
  return async (next: boolean) => {
    state.matches = next;
    act(() => listeners.forEach((l) => l()));
    await act(async () => {
      await Promise.resolve();
    });
  };
}

function controls(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]'));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SHEETS: [string, () => React.ReactElement][] = [
  [
    'ConfirmSheet',
    () => (
      <ConfirmSheet
        spec={{ glyph: 'N', glyphColor: 'var(--mako-red)', title: 'Bet NO', confirmLabel: 'Confirm', pendingTitle: 'Placing', rows: [], note: 'Estimate.', doneTitle: 'Done', doneBody: 'Done.' }}
        phase={{ step: 'review' }}
        wallet={{ kind: 'mako', address: '0xC8BF000000000000000000000000000000090F1a' }}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onClose={vi.fn()}
      />
    ),
  ],
  ['SignOutConfirm', () => <SignOutConfirm who={{ authType: 'wallet' }} onClose={vi.fn()} />],
];

describe.each(SHEETS)('%s across the breakpoint', (_name, sheet) => {
  it('moves the trap and focus to the visible variant, and only closing returns focus to the opener', async () => {
    const resize = fakeWidth(true);
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    const openerFocus = vi.spyOn(opener, 'focus');

    const view = render(sheet());
    await act(async () => {
      await Promise.resolve();
    });
    const [desk, mob] = screen.getAllByRole('dialog');
    expect(desk.contains(document.activeElement)).toBe(true);

    // Desktop to mobile.
    await resize(false);
    expect(mob.contains(document.activeElement)).toBe(true);
    expect(openerFocus).not.toHaveBeenCalled();
    const mobControls = controls(mob);
    mobControls[mobControls.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(mob.contains(document.activeElement)).toBe(true);
    mobControls[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(mob.contains(document.activeElement)).toBe(true);

    // And back.
    await resize(true);
    expect(desk.contains(document.activeElement)).toBe(true);
    const deskControls = controls(desk);
    deskControls[deskControls.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(desk.contains(document.activeElement)).toBe(true);
    expect(openerFocus).not.toHaveBeenCalled();

    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('opened on mobile, the trap starts on the mobile sheet', async () => {
    fakeWidth(false);
    render(sheet());
    await act(async () => {
      await Promise.resolve();
    });
    const [, mob] = screen.getAllByRole('dialog');
    expect(mob.contains(document.activeElement)).toBe(true);
  });
});
