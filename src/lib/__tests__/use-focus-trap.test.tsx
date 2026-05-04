// ----------------------------------------------------------------------------
// use-focus-trap.test.tsx
//
// DOM-level tests for useFocusTrap. The trap is the load-bearing
// keyboard-accessibility primitive for the Group 4 TOTP modals
// (codex round-1 MINOR 2 a11y), so the Tab cycling + opener
// restoration semantics need real-DOM coverage.
//
// Pins:
//   - Initial focus on open lands on the first focusable descendant
//     (or the explicit `initialFocusRef` when provided).
//   - Tab from the last focusable wraps to the first.
//   - Shift+Tab from the first focusable wraps to the last.
//   - If focus has escaped the dialog, BOTH Tab and Shift+Tab wrap
//     back inside (codex round-1 MINOR 1 forward-Tab edge case).
//   - On unmount/close, focus restores to the captured opener.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it } from 'vitest';
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { useFocusTrap } from '../use-focus-trap';

afterEach(cleanup);

type DialogProps = {
  initialFocusOnSecondInput?: boolean;
};

function Dialog({ initialFocusOnSecondInput = false }: DialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const initialRef = useRef<HTMLInputElement | null>(null);
  const [open] = useState(true);

  useFocusTrap({
    open,
    containerRef,
    initialFocusRef: initialFocusOnSecondInput ? initialRef : undefined,
  });

  return (
    <div ref={containerRef}>
      <input data-testid="first" type="text" />
      <input ref={initialRef} data-testid="second" type="text" />
      <button type="button" data-testid="last">
        LAST
      </button>
    </div>
  );
}

function Harness({
  showDialog,
  initialFocusOnSecondInput,
}: {
  showDialog: boolean;
  initialFocusOnSecondInput?: boolean;
}) {
  return (
    <div>
      <button type="button" data-testid="opener">
        OPEN
      </button>
      {showDialog && (
        <Dialog initialFocusOnSecondInput={initialFocusOnSecondInput} />
      )}
    </div>
  );
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useFocusTrap', () => {
  it('focuses the first focusable descendant on open', async () => {
    const { getByTestId } = render(<Harness showDialog={true} />);
    await flushMicrotasks();
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('uses initialFocusRef when provided', async () => {
    const { getByTestId } = render(
      <Harness showDialog={true} initialFocusOnSecondInput={true} />,
    );
    await flushMicrotasks();
    expect(document.activeElement).toBe(getByTestId('second'));
  });

  it('Tab from the last focusable wraps to the first', async () => {
    const { getByTestId } = render(<Harness showDialog={true} />);
    await flushMicrotasks();
    const last = getByTestId('last');
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Shift+Tab from the first focusable wraps to the last', async () => {
    const { getByTestId } = render(<Harness showDialog={true} />);
    await flushMicrotasks();
    const first = getByTestId('first');
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('Tab when focus has escaped the dialog wraps back to first (codex MINOR 1)', async () => {
    // Render an external focusable BEFORE the dialog and focus it
    // directly. The trap must wrap forward to the first dialog
    // element on next Tab.
    const { getByTestId } = render(<Harness showDialog={true} />);
    await flushMicrotasks();
    getByTestId('opener').focus();
    expect(document.activeElement).toBe(getByTestId('opener'));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Shift+Tab when focus has escaped wraps back to last', async () => {
    const { getByTestId } = render(<Harness showDialog={true} />);
    await flushMicrotasks();
    getByTestId('opener').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('restores focus to the opener on unmount', async () => {
    const { getByTestId, rerender } = render(
      <Harness showDialog={false} />,
    );
    const opener = getByTestId('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    rerender(<Harness showDialog={true} />);
    await flushMicrotasks();
    expect(document.activeElement).toBe(getByTestId('first'));

    rerender(<Harness showDialog={false} />);
    await flushMicrotasks();
    expect(document.activeElement).toBe(opener);
  });
});
