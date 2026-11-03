// #214 bell badge: useUser rechecks /api/user/me (which carries the unread count) 5 minutes after the last read while
// the account is signed in and the tab is visible, and never for a signed-out visitor or a hidden tab. However many
// callers are mounted, and whenever they mounted, it is one read per 5 minutes.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import * as React from 'react';

import { UNREAD_REFRESH_MS, useUser } from '@/lib/use-user';

let meCalls = 0;
let answer: object = { authed: false };
let status = 200;

beforeEach(() => {
  vi.useFakeTimers();
  meCalls = 0;
  status = 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/user/me') throw new Error(`unexpected ${url}`);
    meCalls += 1;
    return new Response(JSON.stringify(answer), { status });
  }));
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Caller() {
  useUser();
  return null;
}

/// Several useUser callers (headers, pages) on one client. `more` mounts further callers later, as navigation does.
async function mountApp(callers: number) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const tree = (n: number) => (
    <QueryClientProvider client={client}>
      {Array.from({ length: n }, (_, i) => <Caller key={i} />)}
    </QueryClientProvider>
  );
  const { rerender } = render(tree(callers));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return { more: async (n: number) => { rerender(tree(callers + n)); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); } };
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('signed in and visible: one read 5 minutes after the last, however many callers and whenever they mounted', async () => {
  answer = { authed: true, authType: 'wallet', walletAddress: '0x0000000000000000000000000000000000000001', unreadNotifications: 0 };
  const app = await mountApp(5);
  expect(meCalls).toBe(1);
  await advance(60_000);
  await app.more(3); // a page mounted a minute later: refetchOnMount 'always' reads once
  expect(meCalls).toBe(2);
  await advance(UNREAD_REFRESH_MS - 1_000);
  expect(meCalls).toBe(2);
  await advance(1_000); // 5 minutes after the last read
  expect(meCalls).toBe(3);
  await advance(UNREAD_REFRESH_MS * 2);
  expect(meCalls).toBe(5);
});

it('signed out: never polled', async () => {
  answer = { authed: false };
  await mountApp(3);
  const afterMount = meCalls;
  await advance(UNREAD_REFRESH_MS * 3);
  expect(meCalls).toBe(afterMount);
});

it('hidden tab: not polled until it is visible again', async () => {
  answer = { authed: true, authType: 'wallet', walletAddress: '0x0000000000000000000000000000000000000001', unreadNotifications: 2 };
  await mountApp(2);
  const afterMount = meCalls;
  act(() => { focusManager.setFocused(false); });
  await advance(UNREAD_REFRESH_MS * 3);
  expect(meCalls).toBe(afterMount);
});

it('signed in, then a read fails (the route answers 500 on a session lookup failure): still signed in, and the timer retries', async () => {
  answer = { authed: true, authType: 'wallet', walletAddress: '0x0000000000000000000000000000000000000001', unreadNotifications: 0 };
  const seen: Array<boolean> = [];
  function Watcher() { seen.push(useUser().user !== null); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  render(<QueryClientProvider client={client}><Watcher /></QueryClientProvider>);
  await advance(0);
  expect(meCalls).toBe(1);
  status = 500;
  await advance(UNREAD_REFRESH_MS + 1_000); // the timer read and its one retry both fail
  expect(meCalls).toBe(3);
  expect(seen.at(-1)).toBe(true);
  expect(seen.slice(1).every(Boolean)).toBe(true); // never rendered signed out after the first answer
  status = 200;
  answer = { ...answer, unreadNotifications: 1 };
  await advance(UNREAD_REFRESH_MS);
  expect(meCalls).toBe(4);
  expect((client.getQueryData(['user']) as { unreadNotifications?: number }).unreadNotifications).toBe(1);
});
