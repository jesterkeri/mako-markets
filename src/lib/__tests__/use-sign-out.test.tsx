// Sign-out (S1 review): success only when Mako's session, the Privy session and any wallet connection have all
// ended. Anything unfinished is reported, can be retried on its own, and the app is shown signed out only once the
// user is done (so the dialog can report it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

const m = vi.hoisted(() => ({
  push: vi.fn(),
  logout: vi.fn(async () => {}),
  disconnectAsync: vi.fn(async () => {}),
  isConnected: false,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: m.isConnected }),
  useDisconnect: () => ({ disconnectAsync: m.disconnectAsync }),
}));
vi.mock('@/components/PrivyAuth', () => ({ useEmbeddedActions: () => ({ logout: m.logout, exportKey: vi.fn() }) }));

import { useSignOut } from '../use-sign-out';
import { USER_QUERY_KEY } from '../use-user';

let client: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(USER_QUERY_KEY, { authed: true });
  globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  m.push.mockReset();
  m.logout.mockReset().mockImplementation(async () => {});
  m.disconnectAsync.mockReset().mockImplementation(async () => {});
  m.isConnected = false;
});

describe('useSignOut', () => {
  it('everything ends: success, signed out, home', async () => {
    m.isConnected = true;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    let ok = false;
    await act(async () => {
      ok = await result.current.signOut();
    });
    expect(ok).toBe(true);
    expect(m.logout).toHaveBeenCalledTimes(1);
    expect(m.disconnectAsync).toHaveBeenCalledTimes(1);
    expect(result.current.leftover).toBeNull();
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: false });
    expect(m.push).toHaveBeenCalledWith('/');
  });

  it("Mako's session failing to end changes nothing", async () => {
    globalThis.fetch = vi.fn(async () => new Response('x', { status: 500 })) as typeof fetch;
    const { result } = renderHook(() => useSignOut(), { wrapper });
    let ok = true;
    await act(async () => {
      ok = await result.current.signOut();
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe('Sign-out failed. Nothing changed; try again.');
    expect(m.logout).not.toHaveBeenCalled();
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: true });
  });

  it('a Privy logout that never answers is reported, not taken as success', async () => {
    vi.useFakeTimers();
    m.logout.mockImplementation(() => new Promise<void>(() => {}));
    const { result } = renderHook(() => useSignOut(), { wrapper });
    let ok = true;
    await act(async () => {
      const p = result.current.signOut();
      await vi.advanceTimersByTimeAsync(4_000);
      ok = await p;
    });
    expect(ok).toBe(false);
    expect(result.current.leftover).toEqual({ privy: true, wallet: false });
    expect(m.push).not.toHaveBeenCalled();
    // The dialog stays up: the app is not yet shown signed out.
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: true });
  });

  it('a rejected Privy logout and a failed wallet disconnect are both reported, and retry repeats only those', async () => {
    m.isConnected = true;
    m.logout.mockRejectedValueOnce(new Error('privy down'));
    m.disconnectAsync.mockRejectedValueOnce(new Error('wallet busy'));
    const { result } = renderHook(() => useSignOut(), { wrapper });
    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.leftover).toEqual({ privy: true, wallet: true });
    let ok = false;
    await act(async () => {
      ok = await result.current.retry();
    });
    expect(ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // Mako's session is not ended twice
    expect(m.logout).toHaveBeenCalledTimes(2);
    expect(m.disconnectAsync).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: false });
    expect(m.push).toHaveBeenCalledWith('/');
  });

  it('leaving anyway shows the app signed out and goes home', async () => {
    m.logout.mockRejectedValueOnce(new Error('privy down'));
    const { result } = renderHook(() => useSignOut(), { wrapper });
    await act(async () => {
      await result.current.signOut();
    });
    act(() => result.current.leave());
    expect(client.getQueryData(USER_QUERY_KEY)).toEqual({ authed: false });
    expect(m.push).toHaveBeenCalledWith('/');
  });
});
