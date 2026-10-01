// Settings (21a), rendered for an email account and a wallet account: each row says what is true for that kind of
// account, the security actions reach the existing flows, and what is not built shows as coming soon.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  exportKey: vi.fn(async () => {}),
  setPreference: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('wagmi', () => ({ useBlockNumber: () => ({ data: 67_100_000n }) }));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: mocks.user, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));
vi.mock('@/lib/use-theme', () => ({ useTheme: () => ({ theme: 'dark', preference: 'auto', setTheme: vi.fn(), setPreference: mocks.setPreference }) }));
vi.mock('@/components/PrivyAuth', () => ({ useEmbeddedActions: () => ({ logout: vi.fn(), exportKey: mocks.exportKey }) }));
vi.mock('@/components/profile/TotpEnrollmentModal', () => ({ TotpEnrollmentModal: ({ open }: { open: boolean }) => (open ? <div>enroll-modal</div> : null) }));
vi.mock('@/components/profile/TotpDisableModal', () => ({ TotpDisableModal: ({ open }: { open: boolean }) => (open ? <div>disable-modal</div> : null) }));
vi.mock('@/components/profile/RegenerateRecoveryCodesModal', () => ({ RegenerateRecoveryCodesModal: ({ open }: { open: boolean }) => (open ? <div>regenerate-modal</div> : null) }));
vi.mock('@/components/shell/SignOutConfirm', () => ({
  maskEmail: (e: string) => e,
  SignOutConfirm: () => <div>sign-out-confirm</div>,
}));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a href="/signin">{children}</a> }));

import { SettingsClient } from '@/app/settings/SettingsClient';

const SAFE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WALLET = '0xcccccccccccccccccccccccccccccccccccccccc';
const emailUser = (over: Record<string, unknown> = {}) => ({
  authed: true,
  authType: 'magic',
  email: 'a@b.co',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: SAFE,
  displayName: 'joshua',
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
  ...over,
});
const walletUser = { authed: true, authType: 'wallet', walletAddress: WALLET, displayName: null, avatarUrl: null, lastSignInAt: '2026-09-29T10:00:00Z' };

afterEach(() => {
  cleanup();
  mocks.exportKey.mockClear();
  mocks.setPreference.mockClear();
});

describe('Settings', () => {
  it('email account: gas is covered, 2FA can be turned on, the key can be exported', async () => {
    mocks.user = emailUser();
    render(<SettingsClient />);
    expect(screen.getAllByText('Email · a@b.co').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Covered by Mako Market').length).toBeGreaterThan(0);
    expect(screen.getAllByText('This is your first sign-in.').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn on' })[0]);
    expect(screen.getByText('enroll-modal')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show private key' })[0]);
    await waitFor(() => expect(mocks.exportKey).toHaveBeenCalledTimes(1));
  });

  it('email account with 2FA on offers new recovery codes and turning it off', () => {
    mocks.user = emailUser({ totpEnabled: true, totpEnabledAt: '2026-09-01T12:00:00Z' });
    render(<SettingsClient />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn off' })[0]);
    expect(screen.getByText('disable-modal')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New recovery codes' })[0]);
    expect(screen.getByText('regenerate-modal')).toBeTruthy();
  });

  it('shows why the key export failed', async () => {
    mocks.user = emailUser();
    mocks.exportKey.mockRejectedValueOnce(new Error('Email sign-in is not configured on this deployment.'));
    render(<SettingsClient />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show private key' })[0]);
    await waitFor(() => expect(screen.getAllByRole('alert')[0].textContent).toBe('Email sign-in is not configured on this deployment.'));
  });

  it('wallet account: pays its own gas, has no 2FA or key export', () => {
    mocks.user = walletUser;
    render(<SettingsClient />);
    expect(screen.getAllByText('Paid by your wallet, in MON').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Turn on' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Show private key' })).toHaveLength(0);
    expect(screen.queryAllByText('Covered by Mako Market')).toHaveLength(0);
  });

  it('notifications are not working switches, Replay tour starts How to play, and sign out opens the confirm', () => {
    mocks.user = emailUser();
    render(<SettingsClient />);
    for (const s of screen.getAllByRole('switch')) expect(s.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByRole('link', { name: 'Replay tour' })[0].getAttribute('href')).toBe('/?tour=1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]);
    expect(screen.getByText('sign-out-confirm')).toBeTruthy();
  });

  it('the theme choice goes to the theme store', () => {
    mocks.user = emailUser();
    render(<SettingsClient />);
    fireEvent.click(screen.getAllByRole('radio', { name: 'Light' })[0]);
    expect(mocks.setPreference).toHaveBeenCalledWith('light');
  });

  it('keeps the shipped-copy rules', () => {
    for (const u of [emailUser(), walletUser]) {
      mocks.user = u;
      const { container } = render(<SettingsClient />);
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\b(we|our|us|team)\b/i);
      expect(text).not.toMatch(/Mako Markets/);
      cleanup();
    }
  });

  it('signed out: asks to sign in', () => {
    mocks.user = null;
    render(<SettingsClient />);
    expect(screen.getByText('Sign in to manage your account, security and appearance.')).toBeTruthy();
  });
});
