// ----------------------------------------------------------------------------
// modal-close-arbitrator.test.tsx
//
// DOM-level tests for useModalCloseArbitrator. The arbitrator is the
// load-bearing recovery-code dismissal gate (codex round-1 MAJOR 1
// scope), so behaviour that's almost entirely event-driven needs
// real-DOM coverage.
//
// Pins:
//   - The visible-CLOSE handler `requestClose` consults `allowed()`.
//   - Escape is captured (Phase 1G round-1 MINOR 2) and consults
//     `allowed()`; refused dismissal swallows the keystroke.
//   - Backdrop click only counts when target === currentTarget;
//     clicks bubbling up from dialog content do NOT close.
//   - beforeunload sets event.returnValue = '' and calls
//     preventDefault while gated.
//   - Listeners are cleaned up on unmount and on `open` going false.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

import { useModalCloseArbitrator } from '../modal-close-arbitrator';

afterEach(cleanup);

type HarnessProps = {
  allowed: () => boolean;
  onClose: () => void;
};

function Harness({ allowed, onClose }: HarnessProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [open] = useState(true);

  const { requestClose, onBackdropClick } = useModalCloseArbitrator({
    open,
    allowed,
    onClose,
    dialogRef,
  });

  return (
    <div data-testid="overlay" onClick={onBackdropClick}>
      <div ref={dialogRef} data-testid="dialog">
        <button type="button" data-testid="close" onClick={requestClose}>
          CLOSE
        </button>
        <input data-testid="input" type="text" />
      </div>
    </div>
  );
}

afterEach(() => {
  // happy-dom retains documents across tests in this suite; cleanup
  // happens via Testing Library's `cleanup` (registered in the
  // global afterEach above) plus per-test `unmount()` calls where
  // explicit lifecycle assertions need it. The vi.restoreAllMocks
  // here only resets spy state.
  vi.restoreAllMocks();
});

describe('useModalCloseArbitrator', () => {
  it('CLOSE button calls onClose when allowed() returns true', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness allowed={() => true} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('CLOSE button does NOT call onClose when allowed() returns false', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness allowed={() => false} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('close'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape key calls onClose when allowed', () => {
    const onClose = vi.fn();
    render(<Harness allowed={() => true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key is refused when allowed() returns false', () => {
    const onClose = vi.fn();
    render(<Harness allowed={() => false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape listener is registered with capture so child stopPropagation cannot bypass', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness allowed={() => true} onClose={onClose} />,
    );
    // Attach a child handler that stops propagation. The arbitrator's
    // capture-phase listener fires BEFORE the bubble-phase child
    // handler — so onClose still fires once.
    const input = getByTestId('input');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape is swallowed in the ALLOWED branch (no propagation to outer listeners)', () => {
    // codex round-2 MINOR 1: even when allowed, the modal must not
    // let Escape propagate to a bubble-phase global handler.
    const onClose = vi.fn();
    const outerHandler = vi.fn();
    document.addEventListener('keydown', outerHandler);
    try {
      render(<Harness allowed={() => true} onClose={onClose} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      // The outer bubble-phase listener registers AFTER the
      // arbitrator's capture-phase listener for the same target;
      // because the arbitrator calls stopPropagation, the outer
      // handler never sees the event.
      const escapeCalls = outerHandler.mock.calls.filter(
        (args) => (args[0] as KeyboardEvent).key === 'Escape',
      );
      expect(escapeCalls.length).toBe(0);
    } finally {
      document.removeEventListener('keydown', outerHandler);
    }
  });

  it('Escape is swallowed in the REFUSED branch too', () => {
    const onClose = vi.fn();
    const outerHandler = vi.fn();
    document.addEventListener('keydown', outerHandler);
    try {
      render(<Harness allowed={() => false} onClose={onClose} />);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
      const escapeCalls = outerHandler.mock.calls.filter(
        (args) => (args[0] as KeyboardEvent).key === 'Escape',
      );
      expect(escapeCalls.length).toBe(0);
    } finally {
      document.removeEventListener('keydown', outerHandler);
    }
  });

  it('backdrop click on the overlay calls onClose', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness allowed={() => true} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicks inside dialog content do NOT trigger backdrop close', () => {
    const onClose = vi.fn();
    const { getByTestId } = render(
      <Harness allowed={() => true} onClose={onClose} />,
    );
    fireEvent.click(getByTestId('input'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('beforeunload preventDefault + sets returnValue when gated', () => {
    const onClose = vi.fn();
    render(<Harness allowed={() => false} onClose={onClose} />);

    const ev = new Event('beforeunload', { cancelable: true });
    // Simulate the legacy returnValue property the runtime may set.
    Object.defineProperty(ev, 'returnValue', {
      value: 'initial',
      writable: true,
    });
    const preventSpy = vi.spyOn(ev, 'preventDefault');

    act(() => {
      window.dispatchEvent(ev);
    });

    expect(preventSpy).toHaveBeenCalled();
    expect((ev as unknown as { returnValue: string }).returnValue).toBe('');
  });

  it('beforeunload does NOT preventDefault when allowed', () => {
    const onClose = vi.fn();
    render(<Harness allowed={() => true} onClose={onClose} />);

    const ev = new Event('beforeunload', { cancelable: true });
    const preventSpy = vi.spyOn(ev, 'preventDefault');
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(preventSpy).not.toHaveBeenCalled();
  });

  it('listeners are removed on unmount (no leaked Escape after dismount)', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Harness allowed={() => true} onClose={onClose} />,
    );
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('predicate is read fresh each call (no stale closure)', () => {
    let allow = false;
    const onClose = vi.fn();
    render(<Harness allowed={() => allow} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // Flip the predicate without re-rendering. The arbitrator reads
    // it via a ref so the new value is visible immediately.
    allow = true;
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
