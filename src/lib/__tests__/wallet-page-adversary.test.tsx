// Adversary on e442601 (/wallet send). Spec items quoted per case. Each case fails against e442601.
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

describe('/wallet adversary on e442601', () => {
  // Spec 3: "'No USDC left your wallet' only where the flow knows nothing moved; an unknown outcome shows the
  // transaction to check." The signed op was posted to /api/aa/send and the connection dropped before the answer
  // came back: the send may have landed. confirm-outcome.ts itself says so for the same case ("A dropped connection
  // ... after signing may still have reached Monad").
  it('a dropped connection after the email send was signed and posted is not "nothing moved"', async () => {
    mocks.user = emailUser;
    const fetchMock = vi.fn(async (path: string) => {
      if (path === '/api/aa/sponsor') return new Response(JSON.stringify(SPONSOR_OK), { status: 200, headers: { 'content-type': 'application/json' } });
      // /api/aa/send: the request left the browser, then the network failed.
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<WalletClient initialTab="send" />);
    review(TO, '5');
    fireEvent.click(sendButton());
    // Wait for the sheet to settle on its failure card, whatever its wording.
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    // The signed op was sent to the send route.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/aa/sponsor', '/api/aa/send']);
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByText('No USDC left your wallet')).toHaveLength(0);
    expect(screen.queryAllByText(/Nothing was sent/)).toHaveLength(0);
  });

  // Spec 2: "Before anything is asked of a wallet or the sponsor, the send is refused when ... it exceeds the
  // balance". The balance refetches (another tab bet 120 USDC) while the sheet is on Review.
  it('a balance that drops below the amount between Review and Send: the wallet is not asked', async () => {
    mocks.user = walletUser;
    mocks.connected = A;
    const view = render(<WalletClient initialTab="send" />);
    review(TO, '150');
    expect(screen.getAllByRole('button', { name: 'Send' }).length).toBeGreaterThan(0);
    mocks.balance = 80_000_000n;
    view.rerender(<WalletClient initialTab="send" />);
    fireEvent.click(sendButton());
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.write).not.toHaveBeenCalled();
  });

  // Spec 3: "The confirm sheet shows exactly what will be sent (amount, recipient)". 0.004 USDC shows as 0.00 and
  // 1.995 USDC as 2.00, more than is sent; the recipient is cut to 0xcccc…cccc.
  it('the sheet shows the exact amount being sent', () => {
    mocks.user = walletUser;
    mocks.connected = A;
    render(<WalletClient initialTab="send" />);
    review(TO, '1.995');
    const dialog = screen.getAllByRole('dialog', { name: 'Confirm in wallet' })[0]!;
    expect(dialog.textContent).toContain('1.995');
    expect(dialog.textContent).not.toContain('2.00 USDC');
  });

  it('the sheet shows the full recipient address being sent to', () => {
    mocks.user = walletUser;
    mocks.connected = A;
    render(<WalletClient initialTab="send" />);
    const to = '0x1234567890abcdef1234567890abcdef12345678';
    review(to, '1');
    const dialog = screen.getAllByRole('dialog', { name: 'Confirm in wallet' })[0]!;
    expect(dialog.textContent?.toLowerCase()).toContain(to);
  });

  // Spec 2: "the send is refused when: the address is not a valid address". A mixed-case address whose EIP-55
  // checksum is wrong (one hex letter mistyped from 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed, the EIP-55 test
  // vector) is not valid: viem's own isAddress (strict, its default) rejects it.
  it('a mixed-case address with a bad EIP-55 checksum is refused before the sheet opens', () => {
    mocks.user = walletUser;
    mocks.connected = A;
    render(<WalletClient initialTab="send" />);
    review('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', '1');
    expect(screen.queryAllByRole('button', { name: 'Send' })).toHaveLength(0);
  });
});
