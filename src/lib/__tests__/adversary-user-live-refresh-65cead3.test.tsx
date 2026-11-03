// Adversary on 65cead3, #214 bell badge refresh (adopted). Spec rule 1: while an account is signed in and the tab is
// visible, the unread count is re-read every 5 minutes. On 65cead3 a tab whose first read failed (both tries) was never
// polled again. Its second finding (gap = 5 minutes + read time) was accepted as cosmetic and is not kept. Added: once
// such a tab gets a signed-out answer, polling stops (rule 2).

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import * as React from 'react';

import { UNREAD_REFRESH_MS, useUser } from '@/lib/use-user';

const SIGNED_IN = { authed: true, authType: 'wallet', walletAddress: '0x0000000000000000000000000000000000000001', unreadNotifications: 0 };

let reads: number[] = [];
let respond: () => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/user/me') throw new Error(`unexpected ${url}`);
    reads.push(Date.now());
    return respond();
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

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  render(<QueryClientProvider client={client}><Caller /><Caller /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('signed in, first read hits a 5xx (both tries), backend recovers: re-read within 5 minutes', async () => {
  respond = async () => new Response('{}', { status: 503 });
  await mount();
  await advance(1_000); // retry: 1 after 500 ms, both fail
  const afterOutage = reads.length;
  expect(afterOutage).toBe(2);
  respond = async () => new Response(JSON.stringify(SIGNED_IN), { status: 200 });
  await advance(UNREAD_REFRESH_MS * 3); // a page left open for 15 minutes, tab visible the whole time
  expect(reads.length).toBeGreaterThan(afterOutage);
});

it('first read fails, then the backend answers signed out: polling stops', async () => {
  respond = async () => new Response('{}', { status: 503 });
  await mount();
  await advance(1_000);
  respond = async () => new Response(JSON.stringify({ authed: false }), { status: 200 });
  await advance(UNREAD_REFRESH_MS); // the recovery read
  const afterRecovery = reads.length;
  expect(afterRecovery).toBe(3);
  await advance(UNREAD_REFRESH_MS * 3);
  expect(reads.length).toBe(afterRecovery);
});
