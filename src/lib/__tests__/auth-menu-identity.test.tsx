// ----------------------------------------------------------------------------
// auth-menu-identity.test.tsx
//
// Pins the Group 5A AuthMenu render contract for the post-auth
// identity pill. Three branches:
//   - Magic user with displayName → AvatarCircle + display name
//   - Magic user without displayName → AvatarCircle + email fallback
//   - Wallet-only user → formatted address span (no AvatarCircle —
//     wallet has no displayName/avatar/magicEoa to feed it)
//
// Heavy hooks (useUser, useAccount, useDisconnect, useRouter,
// useQueryClient) are stubbed at the module level so the render
// contract test doesn't have to spin up real query clients or wagmi
// providers. The component's own behavior — what it renders for each
// auth state — is the load-bearing assertion.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { type AuthedUser } from '../use-user';

// Mutable cache the useUser stub reads on each call. Tests flip this
// before render. Same pattern works for useAccount; redeclare per-test
// for clarity.
let mockUser: AuthedUser | null = null;
let mockConnectedWallet: `0x${string}` | undefined = undefined;

vi.mock('../use-user', async () => {
  const actual = await vi.importActual<typeof import('../use-user')>(
    '../use-user',
  );
  return {
    ...actual,
    useUser: () => ({
      user: mockUser,
      isLoading: false,
      isError: false,
      refetch: () => Promise.resolve({}),
    }),
  };
});

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mockConnectedWallet }),
  useDisconnect: () => ({ disconnect: () => {} }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<
    typeof import('@tanstack/react-query')
  >('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({ setQueryData: () => {} }),
  };
});

import { AuthMenu } from '../../components/AuthMenu';

const MAGIC_USER_BASE: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'joshua@example.com',
  magicEoa: '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  safeAddress: '0xff00ff00ff00ff00ff00ff00ff00ff00ff00ff00',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

afterEach(() => {
  cleanup();
  mockUser = null;
  mockConnectedWallet = undefined;
});

describe('AuthMenu — identity pill', () => {
  it('Magic user with displayName renders avatar + display name', () => {
    mockUser = {
      ...MAGIC_USER_BASE,
      displayName: 'Joshua',
      avatarUrl: 'https://example.com/avatar.webp',
    };
    const { container } = render(<AuthMenu />);
    // AvatarCircle renders an <img> when avatarUrl is set.
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain('Joshua');
    // Display name should win over the email fallback.
    expect(container.textContent).not.toContain('joshua@example.com');
  });

  it('Magic user without displayName falls back to email', () => {
    mockUser = { ...MAGIC_USER_BASE, displayName: null, avatarUrl: null };
    const { container } = render(<AuthMenu />);
    expect(container.textContent).toContain('joshua@example.com');
  });

  it('Magic user without avatarUrl renders AvatarCircle initial fallback (no <img>)', () => {
    mockUser = { ...MAGIC_USER_BASE, displayName: 'Joshua', avatarUrl: null };
    const { container } = render(<AuthMenu />);
    expect(container.querySelector('img')).toBeNull();
    // Initial-letter circle is a div with the first character.
    expect(container.textContent).toContain('Joshua');
  });

  it('Wallet-only user renders formatted address (no AvatarCircle)', () => {
    mockUser = null;
    mockConnectedWallet =
      '0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2' as `0x${string}`;
    const { container } = render(<AuthMenu />);
    expect(container.querySelector('img')).toBeNull();
    // Truncated address: slice(0, 6) + "…" + slice(-4) = "0xa1b2…a1b2".
    expect(container.textContent).toMatch(/0xa1b2…a1b2/);
  });

  it('renders SIGN IN link when neither Magic nor wallet auth is present', () => {
    mockUser = null;
    mockConnectedWallet = undefined;
    const { container } = render(<AuthMenu />);
    expect(container.textContent).toContain('SIGN IN');
  });
});
