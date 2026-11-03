// Adversary on d0ba93f, #214 bell badge refresh (adopted). A timer read of /api/user/me still in flight when the user
// signs out landed afterwards and wrote the signed-in answer back: the tab showed the account signed in again and kept
// polling. Every direct write to ['user'] now goes through setUserData, which cancels the in-flight read first. Added:
// the mirror case it suspected, a late signed-out answer landing after a sign-in.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import * as React from 'react';

import { UNREAD_REFRESH_MS, setUserData, useUser } from '@/lib/use-user';

const SIGNED_IN = { authed: true, authType: 'wallet', walletAddress: '0x0000000000000000000000000000000000000001', unreadNotifications: 0 };

let reads = 0;
let pending: Array<(r: Response) => void> = [];
let instant = true;

beforeEach(() => {
  vi.useFakeTimers();
  reads = 0;
  pending = [];
  instant = true;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url !== '/api/user/me') throw new Error(`unexpected ${url}`);
    reads += 1;
    if (instant) return Promise.resolve(new Response(JSON.stringify(SIGNED_IN), { status: 200 }));
    return new Promise<Response>((resolve) => { pending.push(resolve); });
  }));
  focusManager.setFocused(true);
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('a timer read in flight at sign-out does not bring the account back or keep polling', async () => {
  const seen: boolean[] = [];
  function Watcher() { seen.push(useUser().user !== null); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  render(<QueryClientProvider client={client}><Watcher /></QueryClientProvider>);
  await advance(0);
  expect(reads).toBe(1);

  instant = false;
  await advance(UNREAD_REFRESH_MS); // the timer read starts; the server read the session before the logout landed
  expect(reads).toBe(2);
  expect(pending).toHaveLength(1);

  // use-sign-out.ts after POST /api/user/logout answered ok
  act(() => { setUserData(client, { authed: false }); });
  await advance(0);
  expect(seen.at(-1)).toBe(false);

  // the in-flight timer read now lands
  await act(async () => { pending[0](new Response(JSON.stringify(SIGNED_IN), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });

  expect(seen.at(-1)).toBe(false); // signed out stays signed out
  instant = true;
  const afterSignOut = reads;
  await advance(UNREAD_REFRESH_MS * 2);
  expect(reads).toBe(afterSignOut); // and a known signed-out visitor is not polled
});

it('a read in flight at sign-in (its answer: signed out) does not undo the sign-in or stop polling', async () => {
  const seen: boolean[] = [];
  function Watcher() { seen.push(useUser().user !== null); return null; }
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  instant = false;
  render(<QueryClientProvider client={client}><Watcher /></QueryClientProvider>);
  await advance(0);
  expect(pending).toHaveLength(1); // the first read is still in flight

  // SignInDialog after the sign-in route answered with the user
  act(() => { setUserData(client, SIGNED_IN as never); });
  await advance(0);
  expect(seen.at(-1)).toBe(true);

  await act(async () => { pending[0](new Response(JSON.stringify({ authed: false }), { status: 200 })); await vi.advanceTimersByTimeAsync(0); });
  expect(seen.at(-1)).toBe(true); // still signed in
  instant = true;
  const afterSignIn = reads;
  await advance(UNREAD_REFRESH_MS);
  expect(reads).toBe(afterSignIn + 1); // and the badge timer runs
});
