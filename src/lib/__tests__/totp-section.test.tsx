// ----------------------------------------------------------------------------
// totp-section.test.tsx
//
// Pins the Magic-only render contract + button → modal mapping for
// the /profile 2FA section. Group 4 plan: wallet-only users
// (user === null) MUST NOT see ENABLE / DISABLE / REGENERATE
// affordances since the backend routes 401 wallet-only sessions
// (the UI just refuses to render the button rather than firing a
// 401 the user can't act on).
// ----------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TotpSection } from '../../components/profile/TotpSection';
import { type AuthedUser } from '../use-user';

// Stub the heavy modal children so the section's render contract
// stays isolated from modal internals. Each stub renders a div
// with a data-testid that opens iff the parent passed open=true.
vi.mock('../../components/profile/TotpEnrollmentModal', () => ({
  TotpEnrollmentModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="enroll-modal" role="dialog" /> : null,
}));
vi.mock('../../components/profile/TotpDisableModal', () => ({
  TotpDisableModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="disable-modal" role="dialog" /> : null,
}));
vi.mock('../../components/profile/RegenerateRecoveryCodesModal', () => ({
  RegenerateRecoveryCodesModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="regenerate-modal" role="dialog" /> : null,
}));

afterEach(cleanup);

const BASE_USER: AuthedUser = {
  authed: true,
  authType: 'magic',
  email: 'joshua@example.com',
  magicEoa: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  safeAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  displayName: null,
  avatarUrl: null,
  totpEnabled: false,
  totpEnabledAt: null,
  lastSignInAt: null,
  nextEmailChangeAvailableAt: null,
};

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

function withQc(ui: React.ReactNode) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('TotpSection', () => {
  it('renders nothing when user is null (wallet-only branch)', () => {
    const { container } = render(withQc(<TotpSection user={null} />));
    expect(container.firstChild).toBeNull();
  });

  it('Magic user with totpEnabled=false → shows ENABLE 2FA only', () => {
    const { container, queryByText } = render(
      withQc(<TotpSection user={BASE_USER} />),
    );
    expect(container.textContent).toContain('2FA DISABLED');
    expect(queryByText('ENABLE 2FA')).toBeTruthy();
    expect(queryByText('DISABLE 2FA')).toBeNull();
    expect(queryByText('REGENERATE RECOVERY CODES')).toBeNull();
  });

  it('Magic user with totpEnabled=true → shows DISABLE + REGENERATE + enabled-on date', () => {
    const enabled: AuthedUser = {
      ...BASE_USER,
      totpEnabled: true,
      totpEnabledAt: '2026-04-15T00:00:00.000Z',
    };
    const { container, queryByText } = render(
      withQc(<TotpSection user={enabled} />),
    );
    expect(container.textContent).toContain('2FA ENABLED');
    expect(container.textContent).toContain('Enabled');
    expect(queryByText('DISABLE 2FA')).toBeTruthy();
    // Reset-codes label appears both on the button AND inside the
    // "Did you save your codes?" advice paragraph (as a <strong>),
    // so query by role to disambiguate.
    expect(
      container.querySelector('button.mako-button.mako-button--ghost'),
    ).not.toBeNull();
    expect(queryByText('ENABLE 2FA')).toBeNull();
  });

  it('clicking ENABLE 2FA opens the enrollment modal', () => {
    const { getByText, queryByTestId } = render(
      withQc(<TotpSection user={BASE_USER} />),
    );
    expect(queryByTestId('enroll-modal')).toBeNull();
    fireEvent.click(getByText('ENABLE 2FA'));
    expect(queryByTestId('enroll-modal')).not.toBeNull();
  });

  it('clicking DISABLE 2FA opens the disable modal', () => {
    const enabled: AuthedUser = {
      ...BASE_USER,
      totpEnabled: true,
      totpEnabledAt: '2026-04-15T00:00:00.000Z',
    };
    const { getByText, queryByTestId } = render(
      withQc(<TotpSection user={enabled} />),
    );
    expect(queryByTestId('disable-modal')).toBeNull();
    fireEvent.click(getByText('DISABLE 2FA'));
    expect(queryByTestId('disable-modal')).not.toBeNull();
  });

  it('clicking REGENERATE RECOVERY CODES opens the regenerate modal', () => {
    const enabled: AuthedUser = {
      ...BASE_USER,
      totpEnabled: true,
      totpEnabledAt: '2026-04-15T00:00:00.000Z',
    };
    const { container, queryByTestId } = render(
      withQc(<TotpSection user={enabled} />),
    );
    expect(queryByTestId('regenerate-modal')).toBeNull();
    // Find by button role (label appears in advice paragraph too).
    const regenerateBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => b.textContent === 'REGENERATE RECOVERY CODES');
    expect(regenerateBtn).toBeDefined();
    fireEvent.click(regenerateBtn!);
    expect(queryByTestId('regenerate-modal')).not.toBeNull();
  });
});
