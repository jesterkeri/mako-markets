// Rounds not configured (no NEXT_PUBLIC_MAKO_ROUNDS_ADDRESS): Me's rounds read is `off`, exactly as before discovery
// existed, and the discovery route is never asked.

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createConfig, custom, WagmiProvider } from 'wagmi';

import { monadTestnet } from '@/lib/chain';

vi.mock('@/lib/contract', async (orig) => ({ ...(await orig<typeof import('@/lib/contract')>()), ROUNDS_ADDRESS: null }));

const { useMeRounds } = await import('@/lib/use-me-rounds');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('off, with no discovery request and no chain read', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const request = vi.fn(async () => {
    throw new Error('no chain read expected');
  });
  const config = createConfig({
    chains: [monadTestnet],
    transports: { [monadTestnet.id]: custom({ request }, { retryCount: 0 }) },
    multiInjectedProviderDiscovery: false,
    ssr: false,
  });
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <WagmiProvider config={config} reconnectOnMount={false}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
  const { result } = renderHook(() => useMeRounds('0x00000000000000000000000000000000000000a5'), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('off'));
  await new Promise((r) => setTimeout(r, 100));
  expect(result.current.status).toBe('off');
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
