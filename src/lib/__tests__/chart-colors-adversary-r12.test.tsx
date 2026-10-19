// @vitest-environment jsdom
// Adversary r12 on feat/chart-colors@0260e2a: the real useChartColors hook (renderHook), one QueryClient, with only the
// network and the signed-in user stubbed. The fake server applies saves via chart-colors-fake.ts.
// Claim: a carried change "is cleared once sent successfully, by Reset, or when the last save in the queue fails".
// 1. (Fails.) A save fails while a later save for the same account is queued, so its change is carried; the user signs
//    out before the queued save runs, so that save is dropped and the carry is never cleared. Meanwhile the account
//    changes the rising body elsewhere (another device). The user signs back in, sees that newer colour, changes only the
//    falling body, and the stale carried rising body rides along and overwrites the newer one.
// 2. (Fails.) A colour change fails with a Reset queued behind it, the Reset also fails with a third change queued. The
//    third save still carries the colour from before the Reset, and its success clears the error, so the account ends
//    up holding a colour the user reset away and no "Not saved" is shown.
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHART_COLORS, type ChartColors } from '../chart-colors';

const userA = { authed: true, authType: 'wallet', walletAddress: '0xa', displayName: null, avatarUrl: null, lastSignInAt: null };
const auth = vi.hoisted(() => ({ user: null as unknown }));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: auth.user }) }));

import { useChartColors } from '../use-chart-colors';
import { applySave } from './chart-colors-fake';

let stored: unknown = null;
let posts: { account: string; patch: Partial<ChartColors> | null }[] = [];
// Which POSTs (1-based) fail with a 500 after 1 s; the others succeed at once.
let failing = new Set<number>();
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  auth.user = userA;
  stored = { ...DEFAULT_CHART_COLORS, upBody: '#0000ff' };
  posts = [];
  failing = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { account: string; patch: Partial<ChartColors> | null };
        posts.push(body);
        if (failing.has(posts.length)) {
          await new Promise((r) => setTimeout(r, 1000));
          return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        }
        stored = applySave(stored, body);
        return new Response(JSON.stringify({ colors: stored }), { status: 200 });
      }
      return new Response(JSON.stringify({ colors: stored }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useChartColors(), { wrapper });
}

describe('adversary r12: the carried change', () => {
  it('a carry whose save was dropped at sign-out never overwrites a newer colour after signing back in', async () => {
    failing = new Set([1]);
    const h = mount();
    await tick(50);
    expect(h.result.current.canSave).toBe(true);
    // Save 1 (rising body) hangs 1 s then fails; save 2 (falling wick) is queued behind it.
    act(() => void h.result.current.save({ upBody: '#111111' }));
    await tick(10);
    act(() => void h.result.current.save({ downWick: '#222222' }));
    await tick(10);
    // Sign out while save 1 is in flight: save 2 is dropped when its turn comes.
    auth.user = null;
    h.rerender();
    await tick(2000);
    expect(posts).toHaveLength(1);
    // Another device on the same account sets the rising body meanwhile.
    stored = { ...(stored as ChartColors), upBody: '#333333' };
    // Sign back in: the chart loads the account's colours (the newer rising body).
    auth.user = userA;
    h.rerender();
    await tick(50);
    expect(h.result.current.colors.upBody).toBe('#333333');
    // The user changes only the falling body.
    act(() => void h.result.current.save({ downBody: '#444444' }));
    await tick(50);
    expect({ sent: posts.at(-1)?.patch, storedUpBody: (stored as ChartColors).upBody }).toEqual({
      sent: { downBody: '#444444' },
      storedUpBody: '#333333',
    });
  });

  it('a change from before a Reset that also failed is not carried past it and silently saved', async () => {
    failing = new Set([1, 2]);
    const h = mount();
    await tick(50);
    // Rising body (fails), then Reset (fails), then falling wick (succeeds), queued one behind another.
    act(() => void h.result.current.save({ upBody: '#111111' }));
    await tick(10);
    act(() => void h.result.current.save(null));
    await tick(10);
    act(() => void h.result.current.save({ downWick: '#222222' }));
    await tick(3000);
    expect(posts).toHaveLength(3);
    expect(posts[1].patch).toBeNull();
    // The user reset after picking #111111: the account must not end up holding it with no error shown.
    expect({ storedUpBody: (stored as ChartColors).upBody, saveFailed: h.result.current.saveFailed }).not.toEqual({
      storedUpBody: '#111111',
      saveFailed: false,
    });
  });
});
