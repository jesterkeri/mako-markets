// The Me page's live name check (src/app/me/use-name-check.ts): asks only after typing pauses, skips the current name
// and invalid drafts, and never shows a verdict for an older draft.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNameCheck } from '@/app/me/use-name-check';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});
const reply = (body: unknown) => fetchMock.mockResolvedValueOnce({ json: async () => body });

describe('useNameCheck', () => {
  it('checking, then taken, 400 ms after the last keystroke', async () => {
    reply({ available: false, reason: 'taken' });
    const { result } = renderHook(() => useNameCheck('Belle', 'jester', true));
    expect(result.current).toBe('checking');
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('taken');
  });
  it('the current name (any case), an invalid draft, or not editing: idle and no request', async () => {
    for (const [draft, editing] of [['JESTER', true], ['bad<', true], ['Belle', false]] as const) {
      const { result } = renderHook(() => useNameCheck(draft, 'jester', editing));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(result.current, draft).toBe('idle');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('typing on: the earlier draft is never asked about, and its answer is never shown', async () => {
    reply({ available: true });
    const { result, rerender } = renderHook(({ d }) => useNameCheck(d, null, true), { initialProps: { d: 'Bel' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ d: 'Belle' });
    expect(result.current).toBe('checking');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('name=Belle');
    expect(result.current).toBe('available');
  });
});
