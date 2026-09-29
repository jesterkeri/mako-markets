// The Privy bridge registers the embedded wallet that is THIS account's signer, never simply the first one
// Privy lists (Codex T2.2 review r1), and signing fails clearly when that wallet is not available.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import * as React from 'react';

const W0 = '0x' + 'a'.repeat(40);
const W1 = '0x' + 'b'.repeat(40);

const state = vi.hoisted(() => ({
  wallets: [] as { walletClientType: string; address: string; getEthereumProvider: () => Promise<unknown> }[],
  owner: null as string | null,
  register: vi.fn(),
  clear: vi.fn(),
  missing: vi.fn(),
}));

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ ready: true, authenticated: true, logout: async () => {}, exportWallet: async () => {} }),
  useWallets: () => ({ ready: true, wallets: state.wallets }),
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({
    user: state.owner ? { authed: true, authType: 'magic', magicEoa: state.owner } : null,
  }),
}));
vi.mock('@/lib/embedded-signer', () => ({
  registerEmbeddedSigner: state.register,
  clearEmbeddedSigner: state.clear,
  markEmbeddedSignerMissing: state.missing,
}));

import { EmbeddedSignerBridge } from '@/components/PrivyAuth';

const wallet = (address: string, type = 'privy') => ({
  walletClientType: type,
  address,
  getEthereumProvider: async () => ({ tag: address }),
});

afterEach(() => {
  cleanup();
  state.register.mockReset();
  state.clear.mockReset();
  state.missing.mockReset();
});

describe('EmbeddedSignerBridge', () => {
  it("registers the account's own wallet when it is not the first Privy lists", async () => {
    state.wallets = [wallet(W0), wallet(W1)];
    state.owner = W1;
    render(<EmbeddedSignerBridge />);
    await waitFor(() => expect(state.register).toHaveBeenCalledWith(W1, { tag: W1 }));
    expect(state.register).not.toHaveBeenCalledWith(W0, expect.anything());
  });

  it('matches the owner whatever the address case', async () => {
    state.wallets = [wallet(W0.toUpperCase().replace('0X', '0x'))];
    state.owner = W0;
    render(<EmbeddedSignerBridge />);
    await waitFor(() => expect(state.register).toHaveBeenCalledTimes(1));
  });

  it("registers nothing, and reports the wallet missing, when none is the account's signer", async () => {
    state.wallets = [wallet(W0)];
    state.owner = W1;
    render(<EmbeddedSignerBridge />);
    await waitFor(() => expect(state.missing).toHaveBeenCalled());
    expect(state.register).not.toHaveBeenCalled();
  });

  it('never registers an external wallet, even at the owner address', async () => {
    state.wallets = [wallet(W1, 'metamask')];
    state.owner = W1;
    render(<EmbeddedSignerBridge />);
    await waitFor(() => expect(state.missing).toHaveBeenCalled());
    expect(state.register).not.toHaveBeenCalled();
  });

  it('clears the signer when no email account is signed in', async () => {
    state.wallets = [wallet(W0)];
    state.owner = null;
    render(<EmbeddedSignerBridge />);
    await waitFor(() => expect(state.clear).toHaveBeenCalled());
    expect(state.register).not.toHaveBeenCalled();
  });
});
