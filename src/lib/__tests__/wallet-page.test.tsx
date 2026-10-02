// /wallet, rendered: send and receive for an email account and a wallet account. The wallet-switch case is the
// adversary's on 2794f4b, ported from the old /profile page: a switch after Review never sends from another wallet.
//
// The wallet model follows @wagmi/core 2.22.1 (src/actions/getConnectorClient.ts): a write naming an account the
// connector no longer holds throws ConnectorAccountNotFoundError before the wallet sees it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { getAddress } from 'viem';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const HASH = `0x${'d4'.repeat(32)}` as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  connected: undefined as `0x${string}` | undefined,
  balance: 200_000_000n as bigint | undefined,
  asked: [] as string[],
  write: vi.fn(),
  receipt: vi.fn(),
  runSendUsdc: vi.fn(),
  refetchBalance: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <svg data-qr={value} /> }));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mocks.connected }),
  usePublicClient: () => ({ waitForTransactionReceipt: (args: unknown) => mocks.receipt(args) }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
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
import { USDC_ADDRESS } from '@/lib/usdc';

const walletUser = { authed: true, authType: 'wallet', walletAddress: A, displayName: null, avatarUrl: null, lastSignInAt: null };
const emailUser = { authed: true, authType: 'magic', email: 'a@b.co', magicEoa: B, safeAddress: SAFE, displayName: null, avatarUrl: null, totpEnabled: false, totpEnabledAt: null, lastSignInAt: null };

beforeEach(() => {
  window.localStorage.clear(); // send holds (src/lib/send-holds.ts) persist per account
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.asked = [];
  mocks.balance = 200_000_000n;
  mocks.write.mockReset();
  mocks.receipt.mockReset();
  mocks.runSendUsdc.mockReset();
  mocks.refetchBalance.mockReset();
  mocks.write.mockImplementation(async (req: { account?: string }) => {
    const now = mocks.connected;
    if (req.account && (!now || req.account.toLowerCase() !== now.toLowerCase())) {
      throw Object.assign(new Error('Account not found for connector.'), { name: 'ConnectorAccountNotFoundError' });
    }
    mocks.asked.push((req.account ?? now ?? '').toLowerCase());
    return HASH;
  });
  mocks.receipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/// Fill the desktop form and press Review send. Returns the error shown, if any.
function review(to: string, amount: string) {
  fireEvent.change(screen.getAllByLabelText('Recipient address')[0]!, { target: { value: to } });
  fireEvent.change(screen.getAllByLabelText('Amount in USDC')[0]!, { target: { value: amount } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Review send' })[0]!);
}
const sendButton = () => screen.getAllByRole('button', { name: 'Send' })[0]!;

describe('/wallet, wallet account', () => {
  it('a switch to another wallet after Review is never asked to send (adversary on 2794f4b)', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    const view = render(<WalletClient initialTab="send" />);
    review(TO, '5');
    mocks.connected = B;
    view.rerender(<WalletClient initialTab="send" />);
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Wallet changed').length).toBeGreaterThan(0));
    expect(mocks.asked).toEqual([]);
  });

  it('sends from the signed-in wallet on Monad, and says Sent only after the receipt', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Sent').length).toBeGreaterThan(0));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.write.mock.calls[0]![0]).toMatchObject({ functionName: 'transfer', args: [getAddress(TO), 5_000_000n], account: A, chainId: 10143 });
    expect(mocks.refetchBalance).toHaveBeenCalled();
  });

  it('refuses to open the sheet when the browser wallet is not the signed-in one', () => {
    mocks.user = walletUser;
    mocks.connected = B;
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/not the one you signed in with/);
    expect(screen.queryAllByRole('button', { name: 'Send' })).toHaveLength(0);
  });
});

describe('/wallet, email account', () => {
  it('sends gas-free through the sponsor with the reviewed recipient and amount', async () => {
    mocks.user = emailUser;
    mocks.runSendUsdc.mockResolvedValue({ kind: 'sent', txHash: HASH });
    render(<WalletClient initialTab="send" />);
    review(TO, '12.5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Sent').length).toBeGreaterThan(0));
    expect(mocks.runSendUsdc).toHaveBeenCalledWith(expect.objectContaining({ recipient: getAddress(TO), amountUsdc: 12_500_000n, magicEoa: B, chainId: 10143 }));
  });

  it('over the per-send cap: refused before anything is asked', () => {
    mocks.user = emailUser;
    render(<WalletClient initialTab="send" />);
    review(TO, '150');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/at most 100\.00 USDC/);
    expect(mocks.runSendUsdc).not.toHaveBeenCalled();
  });

  it('own address, a contract, more than the balance and a bad amount are refused', () => {
    mocks.user = emailUser;
    render(<WalletClient initialTab="send" />);
    review(SAFE, '1');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/your own address/);
    review(USDC_ADDRESS, '1'); // whatever USDC address this build uses (CI sets its own)
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/contract address/);
    review(TO, '250');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/more than your balance/);
    review(TO, '1.1234567');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/up to 6 decimal places/);
  });

  it('a sponsor refusal of the recipient is said plainly, with nothing moved', async () => {
    mocks.user = emailUser;
    mocks.runSendUsdc.mockResolvedValue({ kind: 'sponsor_failed', status: 403, error: 'NOT_ALLOWED', reason: 'bad_send_recipient' });
    render(<WalletClient initialTab="send" />);
    review(TO, '1');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Address not allowed').length).toBeGreaterThan(0));
    expect(screen.getAllByText('No USDC left your wallet').length).toBeGreaterThan(0);
  });

  it('Receive shows the full Safe address, its QR code and Copy', () => {
    mocks.user = emailUser;
    render(<WalletClient initialTab="receive" />);
    expect(screen.getAllByText(SAFE).length).toBeGreaterThan(0);
    expect(document.querySelector(`[data-qr="${SAFE}"]`)).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'Copy address' }).length).toBeGreaterThan(0);
  });
});

describe('/wallet, signed out', () => {
  it('asks to sign in and shows no form', () => {
    mocks.user = null;
    render(<WalletClient initialTab="send" />);
    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.queryAllByLabelText('Recipient address')).toHaveLength(0);
  });
});

describe('/wallet, after an outcome that may have moved funds', () => {
  it('the same send is held once with a warning, and goes only on a deliberate second press', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    mocks.receipt.mockRejectedValueOnce(new Error('Timed out while waiting for transaction'));
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Still confirming').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    expect(mocks.refetchBalance).toHaveBeenCalled();

    review(TO, '5');
    expect(screen.getAllByRole('alert')[0]!.textContent).toMatch(/isn’t confirmed yet/);
    expect(screen.queryAllByRole('button', { name: 'Send' })).toHaveLength(0);

    review(TO, '5'); // the deliberate second press
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0);
  });

  it('a different send is not held', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    mocks.receipt.mockRejectedValueOnce(new Error('Timed out while waiting for transaction'));
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Still confirming').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    review(TO, '6');
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0);
  });

  it('a wallet error that is not a decline offers the explorer, not Try again', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    mocks.write.mockRejectedValueOnce(new Error('Request expired. Please try again.'));
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Check before sending again').length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
    expect(screen.getAllByRole('link', { name: /Open explorer/ })[0]!.getAttribute('href')).toContain(A);
  });
});

describe('/wallet, address forms', () => {
  it('an all-uppercase address is accepted like an all-lowercase one', () => {
    mocks.user = walletUser;
    mocks.connected = A;
    render(<WalletClient initialTab="send" />);
    review(`0x${TO.slice(2).toUpperCase()}`, '5');
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0);
  });
});
