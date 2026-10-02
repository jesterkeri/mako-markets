// Adversary on 91fe6ae (/wallet send, one recipient list, contracts need an acknowledgement). Spec items quoted per
// case. Each case fails against 91fe6ae. Harness copied from wallet-page.test.tsx, email-account path: the gas
// sponsor's refusal is shown in the confirm sheet through emailSendPhase (src/lib/use-wallet-send.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  balance: 200_000_000n as bigint | undefined,
  runSendUsdc: vi.fn(),
  refetchBalance: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-qr={value} /> }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  // A plain address: no code, so no acknowledgement is asked.
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn(), getCode: async () => '0x' }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock('@/lib/hooks', () => ({
  useUsdcBalance: () => ({ data: mocks.balance, isError: false, refetch: mocks.refetchBalance }),
  useEnsureMonadChain: () => async () => {},
}));
vi.mock('@/lib/use-user', () => ({
  useUser: () => ({ user: mocks.user, isLoading: false, isError: false, refetch: vi.fn() }),
  accountAddress: (u: { authType: string; safeAddress?: string; walletAddress?: string }) => (u.authType === 'magic' ? u.safeAddress : u.walletAddress),
}));
vi.mock('@/lib/aa-client', () => ({ runSendUsdc: mocks.runSendUsdc }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a href="/signin">{children}</a> }));

import { WalletClient } from '@/app/wallet/WalletClient';

const emailUser = { authed: true, authType: 'magic', email: 'a@b.co', magicEoa: B, safeAddress: SAFE, displayName: null, avatarUrl: null, totpEnabled: false, totpEnabledAt: null, lastSignInAt: null };

beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.balance = 200_000_000n;
  mocks.runSendUsdc.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function review(to: string, amount: string) {
  fireEvent.change(screen.getAllByLabelText('Recipient address')[0]!, { target: { value: to } });
  fireEvent.change(screen.getAllByLabelText('Amount in USDC')[0]!, { target: { value: amount } });
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Review send' })[0]!);
  });
}

describe('/wallet, the gas sponsor refuses a recipient', () => {
  // Spec 3: "Wording never claims all contracts are blocked." Spec 1: "Any address may receive USDC, including
  // contracts". The sponsor's bad_send_recipient is only ever the sender's own account or a protocol address, so
  // the sheet must not give "a contract" as the reason a send was refused.
  it('does not tell the person the address was refused for being a contract', async () => {
    mocks.user = emailUser;
    mocks.runSendUsdc.mockResolvedValue({ kind: 'sponsor_failed', step: 'sponsor', status: 403, error: 'NOT_ALLOWED', reason: 'bad_send_recipient' });
    render(<WalletClient initialTab="send" />);
    await review(TO, '1');
    fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]!);
    await waitFor(() => expect(screen.getAllByText('Address not allowed').length).toBeGreaterThan(0));
    const sheet = document.body.textContent ?? '';
    expect(sheet).not.toMatch(/\b(a|any) contract\b/i);
  });
});
