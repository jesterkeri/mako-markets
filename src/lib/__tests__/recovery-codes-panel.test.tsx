// ----------------------------------------------------------------------------
// recovery-codes-panel.test.tsx
//
// DOM-level tests for RecoveryCodesPanel. Pure formatting logic is
// covered by recovery-codes-export.test.ts; this file covers the
// clipboard + Blob plumbing the panel actually does.
//
// The test does NOT assert the missing-checkbox invariant — that's
// the parent modal's responsibility (codex round-1 MAJOR 1: gate
// blocks every dismissal path, the panel is reused outside the
// gate).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { RecoveryCodesPanel } from '../../components/profile/RecoveryCodesPanel';

afterEach(cleanup);

const TEN_CODES = [
  'AAAA-BBBB-CC',
  'CCCC-DDDD-EE',
  'EEEE-FFFF-GG',
  'GGGG-HHHH-JJ',
  'JJJJ-KKKK-MM',
  'MMMM-NNNN-PP',
  'PPPP-QQQQ-RR',
  'RRRR-SSSS-TT',
  'TTTT-VVVV-WW',
  'WWWW-XXXX-YY',
];

const writeText = vi.fn().mockResolvedValue(undefined);
const createObjectURL = vi.fn().mockReturnValue('blob:test-url');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  writeText.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

describe('RecoveryCodesPanel', () => {
  it('renders 10 numbered list items', () => {
    const { container } = render(<RecoveryCodesPanel codes={TEN_CODES} />);
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(TEN_CODES.length);
    for (const code of TEN_CODES) {
      expect(container.textContent).toContain(code);
    }
  });

  it('COPY ALL writes a tab-separated string to navigator.clipboard', async () => {
    const { getByText } = render(<RecoveryCodesPanel codes={TEN_CODES} />);
    fireEvent.click(getByText('COPY ALL'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(TEN_CODES.join('\t'));
  });

  it('COPY ALL flips the label to COPIED! after success', async () => {
    const { getByText, queryByText } = render(
      <RecoveryCodesPanel codes={TEN_CODES} />,
    );
    fireEvent.click(getByText('COPY ALL'));
    await waitFor(() => expect(queryByText('COPIED!')).not.toBeNull());
  });

  it('DOWNLOAD .TXT creates a Blob and triggers an anchor click', () => {
    const { getByText } = render(<RecoveryCodesPanel codes={TEN_CODES} />);
    fireEvent.click(getByText('DOWNLOAD .TXT'));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('text/plain');
  });

  it('does NOT render the required-save checkbox (parent owns the gate)', () => {
    const { container } = render(<RecoveryCodesPanel codes={TEN_CODES} />);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('clears the COPIED! timer on unmount (no setState on dead component) — codex round-2 MINOR 2', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByText, unmount } = render(
        <RecoveryCodesPanel codes={TEN_CODES} />,
      );
      fireEvent.click(getByText('COPY ALL'));
      // Let the awaited clipboard.writeText resolve so setCopied(true)
      // schedules its 2s timeout.
      await vi.advanceTimersByTimeAsync(0);
      // Unmount BEFORE the 2s timer fires.
      unmount();
      // Now advance past the timeout — the cleanup effect should have
      // cleared it. If it fires, React 18+ surfaces "setState on
      // unmounted component" via console.error.
      await vi.advanceTimersByTimeAsync(2500);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('drops late writeText resolution if modal unmounts during the await — codex round-3 MINOR', async () => {
    // Replace the clipboard mock with a deferred promise we can
    // resolve manually AFTER unmount. Without the mountedRef guard
    // around the post-await setCopied, that resolution would fire
    // setState on a dead component and React would surface it via
    // console.error.
    let resolveWrite!: () => void;
    const deferred = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockReturnValue(deferred) },
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { getByText, unmount, queryByText } = render(
        <RecoveryCodesPanel codes={TEN_CODES} />,
      );
      fireEvent.click(getByText('COPY ALL'));
      // The component is now awaiting writeText. Unmount BEFORE
      // resolving the promise.
      unmount();
      // Resolve writeText. The post-await continuation fires now.
      resolveWrite();
      // Flush microtasks so the .then handler runs.
      await Promise.resolve();
      await Promise.resolve();
      // No setState should have fired — verified via the absent
      // React error and the absent COPIED! flash (the panel is
      // dismounted anyway).
      expect(errorSpy).not.toHaveBeenCalled();
      expect(queryByText('COPIED!')).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
