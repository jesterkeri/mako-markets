// Key export is bound to the account's own signer (Codex S5 r1 MAJOR 1): Privy's export opens only for the embedded
// wallet whose address the Mako Market account records (`magicEoa`), never the SDK's default wallet, and is refused
// when the browser's Privy session is signed out or holds other wallets.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import * as React from 'react';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const m = vi.hoisted(() => ({
  authenticated: true,
  wallets: [] as { address: string; walletClientType: string }[],
  exportWallet: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
}));
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: React.ReactNode }) => children,
  usePrivy: () => ({ authenticated: m.authenticated, exportWallet: m.exportWallet, logout: m.logout, ready: true }),
  useWallets: () => ({ wallets: m.wallets, ready: true }),
}));
vi.mock('@/lib/embedded-signer', () => ({
  clearEmbeddedSigner: vi.fn(),
  registerEmbeddedSigner: vi.fn(),
  markEmbeddedSignerMissing: vi.fn(),
  markEmbeddedSignerUnavailable: vi.fn(),
}));
vi.mock('@/lib/use-user', () => ({ useUser: () => ({ user: null }) }));

import { EmbeddedActionsProvider, EXPORT_MISMATCH, useEmbeddedActions, type EmbeddedActions } from '@/components/PrivyAuth';

function actions(): EmbeddedActions {
  return renderHook(() => useEmbeddedActions(), { wrapper: EmbeddedActionsProvider }).result.current;
}

afterEach(() => {
  cleanup();
  m.authenticated = true;
  m.wallets = [];
  m.exportWallet.mockClear();
});

describe('exportKey(expectedAddress)', () => {
  it("opens Privy's export for the account's signer even when it is not the first wallet", async () => {
    m.wallets = [
      { address: OTHER, walletClientType: 'privy' },
      { address: OWNER.toUpperCase().replace('0X', '0x'), walletClientType: 'privy' },
    ];
    await actions().exportKey(OWNER);
    expect(m.exportWallet).toHaveBeenCalledTimes(1);
    expect(m.exportWallet).toHaveBeenCalledWith({ address: OWNER.toUpperCase().replace('0X', '0x') });
  });

  it('refuses when the Privy session holds no wallet with that address', async () => {
    m.wallets = [{ address: OTHER, walletClientType: 'privy' }];
    await expect(actions().exportKey(OWNER)).rejects.toThrow(EXPORT_MISMATCH);
    expect(m.exportWallet).not.toHaveBeenCalled();
  });

  it('refuses an external wallet with the same address: only an embedded key can be exported', async () => {
    m.wallets = [{ address: OWNER, walletClientType: 'metamask' }];
    await expect(actions().exportKey(OWNER)).rejects.toThrow(EXPORT_MISMATCH);
    expect(m.exportWallet).not.toHaveBeenCalled();
  });

  it('refuses when the Privy session is signed out, even if a stale wallet list matches', async () => {
    m.authenticated = false;
    m.wallets = [{ address: OWNER, walletClientType: 'privy' }];
    await expect(actions().exportKey(OWNER)).rejects.toThrow(EXPORT_MISMATCH);
    expect(m.exportWallet).not.toHaveBeenCalled();
  });
});
