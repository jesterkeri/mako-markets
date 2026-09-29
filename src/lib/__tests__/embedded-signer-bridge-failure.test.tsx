// Codex T2.2 review r2, end to end through the real signer seam: Privy lists the account's wallet but its
// provider fails to load. A bet placed while it was loading, and every bet after, must be refused at once with
// an actionable error, never left to a 15-second "still loading" timeout, and the failure must not surface as
// an unhandled rejection. Only Privy and the account are mocked; src/lib/embedded-signer.ts is the real one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import * as React from 'react';
import type { Address, Hex } from 'viem';

const OWNER = ('0x' + 'b'.repeat(40)) as Address;

const state = vi.hoisted(() => ({
  getEthereumProvider: (() => Promise.resolve({})) as () => Promise<unknown>,
}));

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ ready: true, authenticated: true, logout: async () => {}, exportWallet: async () => {} }),
  useWallets: () => ({
    ready: true,
    wallets: [{ walletClientType: 'privy', address: OWNER, getEthereumProvider: state.getEthereumProvider }],
  }),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: { authed: true, authType: 'magic', magicEoa: OWNER } }),
}));

import { EmbeddedSignerBridge } from '@/components/PrivyAuth';
import { EmbeddedSignerUnavailable, signSafeOpHash } from '@/lib/embedded-signer';

const args = { hash: ('0x' + 'ab'.repeat(32)) as Hex, magicEoa: OWNER, validAfter: 0n, validUntil: 1_900_000_000n };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/// Follows a promise from the moment it exists, as the bet's caller does: `outcome` is its rejection (or its
/// value) once settled, 'pending' until then.
function track(p: Promise<unknown>): { readonly outcome: unknown } {
  let outcome: unknown = 'pending';
  p.then(
    (v) => (outcome = v),
    (e) => (outcome = e),
  );
  return {
    get outcome() {
      return outcome;
    },
  };
}

/// Lets every microtask run; timers stay frozen, so nothing that needs one can settle.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('EmbeddedSignerBridge with the real signer: Privy cannot load the wallet', () => {
  it('refuses the waiting bet and the next one at once, with no unhandled rejection', async () => {
    let rejectProvider!: (e: unknown) => void;
    state.getEthereumProvider = () =>
      new Promise((_, reject) => {
        rejectProvider = reject;
      });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Timers frozen throughout: only an answer that needs no timer can arrive.
      vi.useFakeTimers();
      render(<EmbeddedSignerBridge />);
      // A bet placed while the wallet is still loading.
      const waiting = track(signSafeOpHash(args));
      await flushMicrotasks();
      expect(waiting.outcome).toBe('pending');

      await act(async () => {
        rejectProvider(new Error('embedded wallet iframe failed'));
      });
      const next = track(signSafeOpHash(args));
      await flushMicrotasks();
      expect(waiting.outcome).toBeInstanceOf(EmbeddedSignerUnavailable);
      expect(next.outcome).toBeInstanceOf(EmbeddedSignerUnavailable);

      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
