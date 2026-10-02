// Adversary on 1e0fd99 (/wallet send). Spec items quoted per case. Each case fails against 1e0fd99.
// Harness copied from wallet-page-adversary.test.tsx (the adversary on e442601).
//
// The email path runs the real runSendUsdc (src/lib/aa-client.ts) with only fetch and the Magic signer stubbed, so
// what the sheet says follows from what the sponsor routes actually did. The sponsor response shape is the one
// src/lib/__tests__/aa-client-run-sponsored-call-op.test.ts uses for SponsorResponse.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
const SAFE = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe' as const;
const TO = '0xcccccccccccccccccccccccccccccccccccccccc' as const;
const HASH = `0x${'d4'.repeat(32)}` as const;

const mocks = vi.hoisted(() => ({
  user: null as unknown,
  connected: undefined as `0x${string}` | undefined,
  balance: 200_000_000n as bigint | undefined,
  write: vi.fn(),
  receipt: vi.fn(),
  sign: vi.fn(),
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
vi.mock('@/lib/embedded-signer', () => ({ signSafeOpHash: (...args: unknown[]) => mocks.sign(...args) }));
vi.mock('@/components/signin/SignInLink', () => ({ SignInLink: ({ children }: { children: React.ReactNode }) => <a href="/signin">{children}</a> }));

import { WalletClient } from '@/app/wallet/WalletClient';

const walletUser = { authed: true, authType: 'wallet', walletAddress: A, displayName: null, avatarUrl: null, lastSignInAt: null };
const emailUser = { authed: true, authType: 'magic', email: 'a@b.co', magicEoa: B, safeAddress: SAFE, displayName: null, avatarUrl: null, totpEnabled: false, totpEnabledAt: null, lastSignInAt: null };

const SPONSOR_OK = {
  pendingUserOpId: 'op-123',
  userOp: {
    sender: SAFE,
    nonce: '0x0',
    initCode: '0x',
    callData: '0x',
    callGasLimit: '0x0',
    verificationGasLimit: '0x0',
    preVerificationGas: '0x0',
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    paymaster: '0x' + '00'.repeat(20),
    paymasterVerificationGasLimit: '0x0',
    paymasterPostOpGasLimit: '0x0',
    paymasterData: '0x',
  },
  safeOpHash: '0x' + 'aa'.repeat(32),
  userOpHash: '0x' + 'bb'.repeat(32),
  validAfter: '0x0',
  validUntil: '0xffffffffffff',
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.balance = 200_000_000n;
  mocks.write.mockReset();
  mocks.receipt.mockReset();
  mocks.sign.mockReset();
  mocks.refetchBalance.mockReset();
  mocks.write.mockResolvedValue(HASH);
  mocks.receipt.mockResolvedValue({ status: 'success', transactionHash: HASH });
  mocks.sign.mockResolvedValue(('0x' + '11'.repeat(77)) as `0x${string}`);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function review(to: string, amount: string) {
  fireEvent.change(screen.getAllByLabelText('Recipient address')[0]!, { target: { value: to } });
  fireEvent.change(screen.getAllByLabelText('Amount in USDC')[0]!, { target: { value: amount } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Review send' })[0]!);
}
const sendButton = () => screen.getAllByRole('button', { name: 'Send' })[0]!;

describe('/wallet adversary on 1e0fd99', () => {
  // Spec 3: "any outcome that could have reached the chain (including a thrown error after signing ...) is shown as
  // unknown with a way to check, never with an invitation to simply try again." The wallet throws an error that is
  // not a decline (a WalletConnect relay that times out after the wallet signed and broadcast). walletSendPhase
  // itself marks it nothingMoved: false, yet offers "Try again" and says the error came "before sending".
  it('a wallet error that is not a decline does not invite a plain retry', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    mocks.write.mockRejectedValue(new Error('Request expired. Please try again.'));
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('No USDC left your wallet')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: 'Try again' })).toHaveLength(0);
  });

  // Spec 3: "No double submission (double click, Enter, retry while pending, close and reopen)." The transfer was
  // broadcast and its receipt never came ("Still confirming"). Close, then Review the same transfer again: the
  // wallet is asked to send the same 150 USDC a second time, with the balance never refetched.
  it('after "Still confirming", closing and reviewing the same transfer does not send it twice', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    mocks.receipt.mockRejectedValue(Object.assign(new Error('Timed out while waiting for transaction'), { name: 'WaitForTransactionReceiptTimeoutError' }));
    render(<WalletClient initialTab="send" />);
    review(TO, '150');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getAllByText('Still confirming').length).toBeGreaterThan(0));
    expect(mocks.write).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    review(TO, '150');
    const send = screen.queryAllByRole('button', { name: 'Send' });
    if (send.length > 0) fireEvent.click(send[0]!);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  // Spec 3: "Outcomes are truthful". The Magic signature is refused (the person closes the Magic prompt), so
  // nothing was ever posted to /api/aa/send and nothing can reach Monad. The sheet says it "may still reach Monad".
  it('an email send whose signing fails, before anything is posted, does not say it may still reach Monad', async () => {
    mocks.user = emailUser;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/aa/sponsor') return new Response(JSON.stringify(SPONSOR_OK), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('unexpected ' + path);
    });
    vi.stubGlobal('fetch', fetchMock);
    mocks.sign.mockRejectedValue(Object.assign(new Error('User denied signature request'), { code: 4001 }));
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.queryAllByRole('status').concat(screen.queryAllByRole('alert')).some((n) => !/Sending USDC/.test(n.textContent ?? ''))).toBe(true));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/aa/sponsor']);
    expect(screen.queryAllByText(/may still reach Monad/)).toHaveLength(0);
  });
});
